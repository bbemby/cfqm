/** cfqm — Cloudflare Workers 入口 */

import { Hono } from 'hono';
import { getConfig, resolveRuntimeConfig } from './config';
import { parseEmbyWebhook, renderTemplate, resolvePosterUrl } from './emby';
import { getDisplayName } from './embyboss';
import { notify } from './channels';
import { isDuplicatePlayback, markPlayback } from './dedup';
import { handleCallback, sendTgMessage, editTgMessage, handleSetCommand, getEditState, answerCallbackQuery, isAdmin } from './tg_bot';
import { DEFAULT_RULES } from './types';

type Bindings = {
  CONFIG: KVNamespace;
  DEDUP: D1Database;
  TG_ADMIN_BOT_TOKEN: string;
  TG_WEBHOOK_SECRET: string;
  TG_ADMIN_CHAT_ID?: string;
  EMBY_SERVER_URL?: string;
  EMBY_API_KEY?: string;
  EMBYBOSS_API_URL?: string;
  EMBYBOSS_BOT_TOKEN?: string;
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
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ status: 'error', message: 'bad json' }, 400);
    }
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

  // 入库事件：可配置跳过单集（Emby 批量入库时一部剧 N 集会发 N 条 webhook）
  if (event.type === 'media_added' && rule.skipEpisodes && event.itemType === 'Episode') {
    console.log('跳过单集入库通知:', event.title);
    return c.json({ status: 'skipped', event: event.type, reason: 'episode' });
  }

  // 没有启用的渠道就不往下走了（省一次白名单查询）
  const hasChannel = cfg.channels.some((ch) => ch.enabled && ch.events?.includes(event.type));
  if (!hasChannel) {
    return c.json({ status: 'no_channels', event: event.type });
  }

  // 播放开始去重：Emby 在暂停/续播、拖进度条、转码重启时会重发 PlaybackStart，
  // 同一用户同一影片 1 分钟内只通知一次。去重读写失败也不阻塞通知（D1 写额度每天 10 万行）。
  if (event.type === 'playback_start' && event.itemId) {
    try {
      const who = event.userId || event.userName || event.deviceId || 'unknown';
      const dedupKey = `dedup:play:${who}:${event.itemId}`;
      const now = Date.now();
      if (await isDuplicatePlayback(c.env.DEDUP, dedupKey, now)) {
        console.log('重复播放开始，已去重:', dedupKey);
        return c.json({ status: 'deduped', event: event.type });
      }
      await markPlayback(c.env.DEDUP, dedupKey, now);
    } catch (e) {
      console.error('去重读写失败，继续推送:', e);
    }
  }

  // embyboss 白名单
  let displayName = `用户：${event.userName}`;
  if (event.type === 'playback_start' || event.type === 'playback_stop') {
    displayName = await getDisplayName(
      rt.embybossApiUrl,
      rt.embybossBotToken,
      rt.whitelistTitle,
      event.userName,
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

  console.log('推送通知:', title);

  // 异步推送（不阻塞 webhook 响应）：海报解析需要多查一次 Emby，也放异步里
  c.executionCtx.waitUntil(
    (async () => {
      const imageUrl = rule.image
        ? await resolvePosterUrl(rt.embyServerUrl, rt.embyApiKey, event.itemId, event.userId, event.seriesId)
        : '';
      const r = await notify(cfg.channels, event.type, { title, content, imageUrl });
      console.log('推送结果:', JSON.stringify(r));
    })().catch((e) => {
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

  let update: any;
  try {
    update = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad json' }, 400);
  }
  if (!update || typeof update !== 'object') {
    return c.json({ ok: true, ignored: true });
  }
  const message = update.message;
  const callback = update.callback_query;
  const chatId = message?.chat?.id ? String(message.chat.id) : null;
  // 管理员按用户 id 校验：私聊里 from.id == chat.id；群里只有 from.id 能区分成员，
  // 且 callback 更新没有顶层 message，必须同时看 callback_query.from
  const userId = message?.from?.id ?? callback?.from?.id ?? null;
  const userIdStr = userId != null ? String(userId) : null;

  // 管理员白名单校验（前置统一 gate，message 和 callback 共用）
  const adminUserId = rt.tgAdminChatId;
  if (!isAdmin(adminUserId, userIdStr)) {
    // 未配置管理员时静默忽略；已配置但非管理员：私聊给一句提示，回调只应答不打扰。
    // 非管理员一律返回 200，避免 Telegram 对 403 反复重试。
    if (adminUserId && message && chatId) {
      await sendTgMessage(botToken, chatId, '⛔ 你不是管理员，无法使用此 Bot。');
    }
    if (callback) {
      await answerCallbackQuery(botToken, callback.id);
    }
    return c.json({ ok: true, ignored: true });
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

  // 处理 /set 编辑命令（/set 本身也匹配，/setup 不再误命中）
  if (message?.text && /^\/set(@\w+)?(\s|$)/.test(message.text)) {
    if (!chatId) return c.json({ ok: false, error: 'no chat id' }, 400);
    const state = await getEditState(kv, chatId);
    if (state) {
      await handleSetCommand(kv, botToken, chatId, message.text);
    } else {
      await sendTgMessage(botToken, chatId, '请先点按钮进入编辑模式。');
    }
    return c.json({ ok: true });
  }

  // 处理按钮回调（前置 gate 已按 from.id 校验过管理员，这里不再重复用 chat id 拦）
  if (callback) {
    const cq = callback;
    const data = cq.data ?? 'noop';
    const cbChatId = cq.message?.chat?.id ? String(cq.message.chat.id) : null;

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
