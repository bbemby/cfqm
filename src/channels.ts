/** 渠道处理器：Telegram / Bark / Webhook */

import { RenderedNotification, EventType } from './types';
import { fetchWithTimeout, withTimeout, FETCH_TIMEOUT_MS } from './http';

export interface SendResult {
  channelId: string;
  status: 'ok' | string;
}

const TG_CAPTION_LIMIT = 1024;
const TG_TEXT_LIMIT = 4096;

/** HTML 转义：片名/用户名里的 <>& 会导致 Telegram 400 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 安全截断的 TG 消息：先在纯文本层定预算、转义后再按预算裁内容，
 *  绝不切断 HTML 实体或代理对（旧代码先转义后 slice 会切出 &am 这种非法 HTML 导致 400）。 */
function buildTgMessage(title: string, content: string, limit: number): string {
  const head = `<b>${escapeHtml(title.slice(0, 200))}</b>\n`;
  const budget = Math.max(0, limit - head.length);
  let body = escapeHtml(content);
  if (body.length > budget) {
    body = body
      .slice(0, budget)
      .replace(/&[a-zA-Z]*$/, '') // 切掉半截实体
      .replace(/[\uD800-\uDBFF]$/, ''); // 切掉半个代理对
  }
  return head + body;
}

/** Telegram 渠道 */
async function sendTelegram(
  botToken: string,
  chatId: string,
  notif: RenderedNotification,
  type: EventType
): Promise<void> {
  const baseUrl = `https://api.telegram.org/bot${botToken}`;

  // 有海报：先下载再上传（Workers 用 fetch；海报 URL 只在 Worker 内使用，不外发）
  if (notif.imageUrl) {
    try {
      const imgResp = await fetchWithTimeout(notif.imageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (imgResp.ok) {
        const imgBlob = await withTimeout(imgResp.blob(), FETCH_TIMEOUT_MS, 'poster blob timeout');
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('caption', buildTgMessage(notif.title, notif.content, TG_CAPTION_LIMIT));
        formData.append('parse_mode', 'HTML');
        formData.append('photo', imgBlob, 'poster.jpg');

        const resp = await fetchWithTimeout(`${baseUrl}/sendPhoto`, { method: 'POST', body: formData });
        if (resp.ok) return;
      }
    } catch {
      // 图片失败降级为纯文本
    }
  }

  // 纯文本
  const message = buildTgMessage(notif.title, notif.content, TG_TEXT_LIMIT);
  const resp = await fetchWithTimeout(`${baseUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    // HTML 解析失败时退回纯文本（不带 parse_mode），避免 HTML 问题导致整条通知丢失
    if (err.toLowerCase().includes('parse')) {
      const plain = `${notif.title}\n${notif.content}`.slice(0, TG_TEXT_LIMIT);
      const retry = await fetchWithTimeout(`${baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: plain }),
      });
      if (retry.ok) return;
      throw new Error(`Telegram ${retry.status}: ${(await retry.text()).slice(0, 200)}`);
    }
    throw new Error(`Telegram ${resp.status}: ${err.slice(0, 200)}`);
  }
}

/** Bark 渠道：不发图片。海报 URL 里带 Emby API Key，发给第三方等于泄 Key。 */
async function sendBark(
  deviceKey: string,
  serverUrl: string,
  notif: RenderedNotification
): Promise<void> {
  const endpoint = (serverUrl || 'https://api.day.app').replace(/\/$/, '');
  const resp = await fetchWithTimeout(`${endpoint}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_key: deviceKey,
      title: notif.title,
      body: notif.content,
    }),
  });
  if (!resp.ok) throw new Error(`Bark ${resp.status}`);
}

/** 通用 Webhook 渠道：同理不发图片，避免 API Key 外泄 */
async function sendWebhook(
  endpoint: string,
  notif: RenderedNotification
): Promise<void> {
  const resp = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: notif.title,
      content: notif.content,
    }),
  });
  if (!resp.ok) throw new Error(`Webhook ${resp.status}`);
}

/** 发送通知到所有匹配渠道 */
function validateChannel(ch: any): string | null {
  if (!ch.config || typeof ch.config !== 'object') return '缺少 config';
  switch (ch.type) {
    case 'telegram':
      if (!ch.config.bot_token) return '缺少 bot_token';
      if (!ch.config.chat_id) return '缺少 chat_id';
      break;
    case 'bark':
      if (!ch.config.device_key) return '缺少 device_key';
      if (ch.config.server_url) {
        try {
          const u = new URL(ch.config.server_url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'server_url 必须是 http(s) 地址';
        } catch {
          return 'server_url 不是合法 URL';
        }
      }
      break;
    case 'webhook':
      if (!ch.config.endpoint) return '缺少 endpoint';
      try {
        new URL(ch.config.endpoint);
      } catch {
        return 'endpoint 不是合法 URL';
      }
      break;
  }
  return null;
}

export async function notify(
  channels: any[],
  type: EventType,
  notif: RenderedNotification
): Promise<SendResult[]> {
  const results: SendResult[] = [];
  const matched = channels.filter(
    (ch) => ch.enabled && ch.events?.includes(type)
  );

  await Promise.all(
    matched.map(async (ch) => {
      const err = validateChannel(ch);
      if (err) {
        results.push({ channelId: ch.id || '?', status: `error: ${err}` });
        return;
      }
      try {
        switch (ch.type) {
          case 'telegram':
            await sendTelegram(ch.config.bot_token, ch.config.chat_id, notif, type);
            break;
          case 'bark':
            await sendBark(ch.config.device_key, ch.config.server_url, notif);
            break;
          case 'webhook':
            await sendWebhook(ch.config.endpoint, notif);
            break;
          default:
            throw new Error(`未知渠道类型: ${ch.type}`);
        }
        results.push({ channelId: ch.id, status: 'ok' });
      } catch (e) {
        results.push({ channelId: ch.id, status: `error: ${e}` });
      }
    })
  );

  return results;
}
