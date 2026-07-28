/** cfqm — Cloudflare Workers 入口 */

import { Hono } from 'hono';
import { getConfig, updateConfig, resolveRuntimeConfig } from './config';
import { parseEmbyWebhook, renderTemplate, buildPosterUrl } from './emby';
import { getDisplayName } from './embyboss';
import { notify } from './channels';
import { handleCallback, sendTgMessage, editTgMessage, handleSetCommand, setEditState, getEditState } from './tg_bot';
import { DEFAULT_RULES } from './types';

type Bindings = {
  CONFIG: KVNamespace;
  TG_ADMIN_BOT_TOKEN?: string;
  EMBY_SERVER_URL?: string;
  EMBY_API_KEY?: string;
  EMBYBOSS_API_URL?: string;
  WHITELIST_TITLE?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// ============ Emby Webhook ============
app.post('/emby/webhook', async (c) => {
  const kv = c.env.CONFIG;
  const cfg = await getConfig(kv);
  const rt = resolveRuntimeConfig(c.env as any, cfg);

  let payload: any;
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('json')) {
    payload = await c.req.json();
  } else {
    const form = await c.req.formData();
    const raw = form.get('data');
    try {
      payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return c.json({ status: 'error', message: 'bad json' }, 400);
    }
  }

  if (!payload || typeof payload !== 'object') {
    return c.json({ status: 'error', message: 'not a dict' }, 400);
  }

  console.log('收到 Emby webhook:', payload.Event);

  const event = parseEmbyWebhook(payload);
  if (!event) {
    console.log('未识别事件:', payload.Event);
    return c.json({ status: 'ignored', event: payload.Event });
  }

  // L2 规则
  const rule = cfg.rules[event.type] ?? DEFAULT_RULES[event.type];
  if (!rule?.enabled) {
    console.log('事件已禁用:', event.type);
    return c.json({ status: 'skipped', event: event.type });
  }

  // embyboss 白名单
  let displayName = `用户：${event.userName}`;
  if (event.type === 'playback_start' || event.type === 'playback_stop') {
    displayName = await getDisplayName(
      rt.embybossApiUrl,
      rt.whitelistTitle,
      event.userId,
      event.userName
    );
  }

  // 渲染通知
  const vars: Record<string, string> = {
    title: event.title,
    user: displayName,
    device: event.deviceName,
    client: event.client,
    year: event.year,
    library: event.library,
    position: event.position,
    duration: event.duration,
    progress: event.progress,
    image: buildPosterUrl(rt.embyServerUrl, event.itemId),
  };

  const title = renderTemplate(rule.titleTemplate, vars);
  const content = renderTemplate(rule.bodyTemplate, vars);
  const imageUrl = rule.image ? buildPosterUrl(rt.embyServerUrl, event.itemId) : '';

  console.log('推送通知:', title);

  // 异步推送（不阻塞 webhook 响应）
  const notif = { title, content, imageUrl };
  c.executionCtx.waitUntil(
    notify(cfg.channels, event.type, notif).then((r) => {
      console.log('推送结果:', JSON.stringify(r));
    }).catch((e) => {
      console.error('推送失败:', e);
    })
  );

  return c.json({ status: 'ok', event: event.type });
});

// ============ TG Bot Webhook ============
app.post('/tg/webhook', async (c) => {
  const kv = c.env.CONFIG;
  const botToken = c.env.TG_ADMIN_BOT_TOKEN;

  if (!botToken) {
    return c.json({ ok: false, error: 'TG_ADMIN_BOT_TOKEN not set' }, 500);
  }

  // 鉴权：请求头 X-TG-Bot-Token 必须匹配；Telegram 也支持 secret_token 字段
  const providedToken = c.req.header('X-TG-Bot-Token');
  if (providedToken !== botToken) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const update = await c.req.json();
  const cfg = await getConfig(kv);
  const message = update.message;

  // 处理 /start
  if (message?.text === '/start') {
    await sendTgMessage(
      botToken,
      message.chat.id,
      '⚙️ <b>cfqm 管理</b>\n\n点击按钮管理配置：',
      { inline_keyboard: [
        [{ text: '📋 通知规则管理', callback_data: 'rules' }],
        [{ text: '📡 通知渠道管理', callback_data: 'channels' }],
        [{ text: '🔄 刷新', callback_data: 'main' }],
      ] }
    );
    // 清空可能残留的编辑状态
    await setEditState(kv, null);
    return c.json({ ok: true });
  }

  // 处理 /set 编辑命令
  if (message?.text && message.text.startsWith('/set')) {
    const state = await getEditState(kv);
    if (state) {
      // 记录当前 chatId（首次进入编辑时可能没有）
      await setEditState(kv, { ...state, chatId: String(message.chat.id) });
      await handleSetCommand(kv, botToken, String(message.chat.id), message.text);
    } else {
      await sendTgMessage(botToken, message.chat.id, '请先点按钮进入编辑模式。');
    }
    return c.json({ ok: true });
  }

  // 处理按钮回调
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data ?? 'noop';
    const result = await handleCallback(data, kv);
    if (result && cq.message?.chat?.id && cq.message?.message_id) {
      await editTgMessage(botToken, String(cq.message.chat.id), cq.message.message_id, result.text, result.keyboard);
    }
    // 回答 callback query
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cq.id }),
    });
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

// ============ 健康检查 ============
app.get('/health', (c) => c.json({ status: 'ok' }));

// ============ 根路径 ============
app.get('/', (c) => c.text('cfqm running ✅'));

export default app;
