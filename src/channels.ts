/** 渠道处理器：Telegram / Bark / Webhook */

import { RenderedNotification, EventType } from './types';

export interface SendResult {
  channelId: string;
  status: 'ok' | string;
}

const TG_CAPTION_LIMIT = 1024;
const TG_TEXT_LIMIT = 4096;
const FETCH_TIMEOUT_MS = 5000;

/** Telegram 渠道 */
async function sendTelegram(
  botToken: string,
  chatId: string,
  notif: RenderedNotification,
  type: EventType
): Promise<void> {
  const baseUrl = `https://api.telegram.org/bot${botToken}`;
  const message = `<b>${notif.title}</b>\n${notif.content}`;

  // 有海报：先下载再上传（Workers 用 fetch）
  if (notif.imageUrl) {
    try {
      const imgResp = await fetch(notif.imageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (imgResp.ok) {
        const imgBlob = await imgResp.blob();
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('caption', message.slice(0, TG_CAPTION_LIMIT));
        formData.append('parse_mode', 'HTML');
        formData.append('photo', imgBlob, 'poster.jpg');

        const resp = await fetch(`${baseUrl}/sendPhoto`, { method: 'POST', body: formData });
        if (resp.ok) return;
      }
    } catch {
      // 图片失败降级为纯文本
    }
  }

  // 纯文本
  const resp = await fetch(`${baseUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message.slice(0, TG_TEXT_LIMIT), parse_mode: 'HTML' }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Telegram ${resp.status}: ${err.slice(0, 200)}`);
  }
}

/** Bark 渠道 */
async function sendBark(
  deviceKey: string,
  serverUrl: string,
  notif: RenderedNotification
): Promise<void> {
  const endpoint = serverUrl || 'https://api.day.app';
  const resp = await fetch(`${endpoint}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_key: deviceKey,
      title: notif.title,
      body: notif.content,
      ...(notif.imageUrl ? { image: notif.imageUrl } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`Bark ${resp.status}`);
}

/** 通用 Webhook 渠道 */
async function sendWebhook(
  endpoint: string,
  notif: RenderedNotification
): Promise<void> {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: notif.title,
      content: notif.content,
      image: notif.imageUrl,
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
