/** cfqm — Cloudflare Workers 入口 */

import { Hono } from 'hono';
import { getConfig, resolveRuntimeConfig } from './config';
import { parseEmbyWebhook, renderTemplate, buildPosterUrl } from './emby';
import { getDisplayName } from './embyboss';
import { notify } from './channels';
import { handleCallback, sendTgMessage, editTgMessage, handleSetCommand, getEditState, answerCallbackQuery, isAdmin } from './tg_bot';
import { DEFAULT_RULES } from './types';

type Bindings = {
  CONFIG: KVNamespace;
  TG_ADMIN_BOT_TOKEN: string;
  TG_WEBHOOK_SECRET: string;
  TG_ADMIN_CHAT_ID?: string;
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
  const rt = resolveRuntimeConfig(c.env, cfg);

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

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
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
  };

  const title = renderTemplate(rule.titleTemplate, vars);
  const content = renderTemplate(rule.bodyTemplate, vars);
  const imageUrl = rule.image ? buildPosterUrl(rt.embyServerUrl, rt.embyApiKey, event.itemId) : '';

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
  const cfg = await getConfig(kv);
  const rt = resolveRuntimeConfig(c.env, cfg);
  const botToken = c.env.TG_ADMIN_BOT_TOKEN;
  const webhookSecret = c.env.TG_WEBHOOK_SECRET;

  if (!botToken) {
    return c.json({ ok: false, error: 'TG_ADMIN_BOT_TOKEN not set' }, 500);
  }

  // 鉴权：Telegram setWebhook 时传入的 secret_token 会带在 X-Telegram-Bot-Api-Secret-Token 头里
  const providedSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (!webhookSecret) {
    return c.json({ ok: false, error: 'TG_WEBHOOK_SECRET not set' }, 500);
  }
  if (providedSecret !== webhookSecret) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const update = await c.req.json();
  const message = update.message;
  const chatId = message?.chat?.id ? String(message.chat.id) : null;

  // 管理员白名单校验
  const adminChatId = rt.tgAdminChatId;
  if (!isAdmin(adminChatId, chatId)) {
    if (chatId) {
      await sendTgMessage(botToken, chatId, '⛔ 你不是管理员，无法使用此 Bot。');
    }
    return c.json({ ok: false, error: 'forbidden' }, 403);
  }

  // 处理 /start（支持 /start@botname）
  if (message?.text && /^\/start(@\w+)?$/.test(message.text)) {
    if (!chatId) return c.json({ ok: false, error: 'no chat id' }, 400);
    await sendTgMessage(
      botToken,
      chatId,
      '⚙️ <b>cfqm 管理</b>\n\n点击按钮管理配置：',
      { inline_keyboard: [
        [{ text: '📋 通知规则管理', callback_data: 'rules' }],
        [{ text: '📡 通知渠道管理', callback_data: 'channels' }],
        [{ text: '🔄 刷新', callback_data: 'main' }],
      ] }
    );
    return c.json({ ok: true });
  }

  // 处理 /set 编辑命令
  if (message?.text && message.text.startsWith('/set')) {
    if (!chatId) return c.json({ ok: false, error: 'no chat id' }, 400);
    const state = await getEditState(kv, chatId);
    if (state) {
      await handleSetCommand(kv, botToken, chatId, message.text);
    } else {
      await sendTgMessage(botToken, chatId, '请先点按钮进入编辑模式。');
    }
    return c.json({ ok: true });
  }

  // 处理按钮回调
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data ?? 'noop';
    const cbChatId = cq.message?.chat?.id ? String(cq.message.chat.id) : null;

    // 回调也要校验管理员
    if (!isAdmin(adminChatId, cbChatId)) {
      await answerCallbackQuery(botToken, cq.id);
      return c.json({ ok: false, error: 'forbidden' }, 403);
    }

    const result = await handleCallback(data, kv, cbChatId);
    if (result && cbChatId && cq.message?.message_id) {
      await editTgMessage(botToken, cbChatId, cq.message.message_id, result.text, result.keyboard);
    }
    await answerCallbackQuery(botToken, cq.id);
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

// ============ 健康检查 ============
app.get('/health', (c) => c.json({ status: 'ok' }));

// ============ 根路径 ============
app.get('/', (c) => c.text('cfqm running ✅'));

export default app;
