/** TG 管理 Bot（webhook 模式）：Telegram 按钮回调 + 命令处理 */

import { AppConfig } from './types';
import { getConfig, updateConfig } from './config';

const TG_API = (token: string) => `https://api.telegram.org/bot${token}`;

/** 校验是否为管理员 */
export function isAdmin(allowedChatId: string, chatId: string | number | null | undefined): boolean {
  if (!allowedChatId) return true; // 未配置则不限制
  return String(chatId) === allowedChatId;
}

/** TG 按钮行 */
type TgRow = { text: string; callback_data: string }[];
function kb(rows: TgRow[]): any {
  return { inline_keyboard: rows };
}

/** HTML 转义（管理员手填的渠道名等） */
function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 主面板 */
function mainMenu(): any {
  return kb([
    [{ text: '📋 通知规则管理', callback_data: 'rules' }],
    [{ text: '📡 通知渠道管理', callback_data: 'channels' }],
    [{ text: '🔄 刷新', callback_data: 'main' }],
  ]);
}

/** 规则列表面板 */
function rulesListMenu(): any {
  const events: [string, string][] = [
    ['media_added', '🎬 媒体入库'],
    ['playback_start', '▶️ 开始播放'],
    ['playback_stop', '⏹️ 停止播放'],
  ];
  const rows: TgRow[] = [[{ text: '📋 通知规则', callback_data: 'noop' }]];
  for (const [ev, name] of events) {
    rows.push([{ text: name, callback_data: `rule:${ev}` }]);
  }
  rows.push([{ text: '🔙 返回', callback_data: 'main' }]);
  return kb(rows);
}

/** 规则详情面板 */
function ruleDetailMenu(ev: string, cfg: AppConfig): any {
  const rule = cfg.rules[ev] ?? { enabled: false, titleTemplate: '', bodyTemplate: '', image: false };
  const on = rule.enabled ? '✔️' : '❌';
  const img = rule.image ? '✔️' : '❌';
  const tShow = rule.titleTemplate.length > 24 ? rule.titleTemplate.slice(0, 22) + '..' : rule.titleTemplate;
  const bShow = rule.bodyTemplate.length > 24 ? rule.bodyTemplate.slice(0, 22) + '..' : rule.bodyTemplate;
  const rows: TgRow[] = [
    [{ text: `${on} 总开关`, callback_data: `rule:${ev}:toggle` }],
    [{ text: `✏️ 标题: ${tShow}`, callback_data: `rule:${ev}:title` }],
    [{ text: `✏️ 正文: ${bShow}`, callback_data: `rule:${ev}:body` }],
    [{ text: `${img} 带海报`, callback_data: `rule:${ev}:image` }],
  ];
  if (ev === 'media_added') {
    const sk = rule.skipEpisodes ? '✔️' : '❌';
    rows.push([{ text: `${sk} 跳过单集`, callback_data: `rule:${ev}:skipepisodes` }]);
  }
  rows.push([{ text: '🔙 返回规则列表', callback_data: 'rules' }]);
  return kb(rows);
}

/** 渠道列表面板 */
function channelsListMenu(cfg: AppConfig): any {
  const rows: TgRow[] = [[{ text: '📡 通知渠道', callback_data: 'noop' }]];
  for (let i = 0; i < cfg.channels.length; i++) {
    const ch = cfg.channels[i];
    const on = ch.enabled ? '✔️' : '❌';
    const name = ch.name || ch.id || `渠道${i}`;
    rows.push([{ text: `${on} ${name} · ${ch.type}`, callback_data: `chan:${i}` }]);
  }
  rows.push([{ text: '➕ 添加渠道', callback_data: 'chan:add' }]);
  rows.push([{ text: '🔙 返回', callback_data: 'main' }]);
  return kb(rows);
}

/** 渠道详情文字 */
function channelDetailText(ch: any): string {
  const evNames: Record<string, string> = { media_added: '入库', playback_start: '播放开始', playback_stop: '播放停止' };
  const evs = (ch.events || []).map((e: string) => evNames[e] || e).join('、') || '无';
  return `📡 <b>${escapeHtml(ch.name || ch.id || '渠道')}</b>\n类型：${escapeHtml(ch.type)}\n状态：${ch.enabled ? '✔️ 启用' : '❌ 禁用'}\n事件：${escapeHtml(evs)}`;
}

/** 渠道详情面板 */
function channelDetailMenu(i: number, enabled: boolean): any {
  const on = enabled ? '✔️' : '❌';
  return kb([
    [{ text: `${on} 总开关`, callback_data: `chan:${i}:toggle` }],
    [{ text: '🗑️ 删除渠道', callback_data: `chan:${i}:del` }],
    [{ text: '🔙 返回渠道列表', callback_data: 'channels' }],
  ]);
}

/** 回调处理 */
export async function handleCallback(
  data: string,
  kv: KVNamespace,
  chatId: string | null
): Promise<{ text: string; keyboard: any } | null> {
  if (data === 'main' || data === 'noop') {
    return { text: '⚙️ <b>cfqm 管理</b>\n\n选择管理项目：', keyboard: mainMenu() };
  }
  if (data === 'rules') {
    return { text: '📋 <b>通知规则管理</b>\n\n选择事件：', keyboard: rulesListMenu() };
  }
  if (data === 'channels') {
    const cfg = await getConfig(kv);
    return { text: '📡 <b>通知渠道管理</b>\n\n选择渠道：', keyboard: channelsListMenu(cfg) };
  }

  // 添加渠道：选择类型
  if (data === 'chan:add') {
    return {
      text: '➕ <b>添加渠道</b>\n\n选择渠道类型：',
      keyboard: kb([
        [{ text: 'Telegram', callback_data: 'chan:add:telegram' }],
        [{ text: 'Bark', callback_data: 'chan:add:bark' }],
        [{ text: 'Webhook', callback_data: 'chan:add:webhook' }],
        [{ text: '🔙 返回', callback_data: 'channels' }],
      ]),
    };
  }

  // 添加渠道：开始分步填写
  if (data.startsWith('chan:add:')) {
    const type = data.slice('chan:add:'.length);
    if (type !== 'telegram' && type !== 'bark' && type !== 'webhook') {
      return { text: '未知渠道类型', keyboard: mainMenu() };
    }
    const step = CHANNEL_STEPS[type][0];
    await setEditState(kv, chatId, { chatId: chatId ?? '', kind: 'channel_add', channelType: type as any, step, draft: {} });
    return { text: channelStepPrompt(type, step), keyboard: channelStepKeyboard(step) };
  }

  // 添加渠道：跳过可选步骤
  if (data === 'chan:skip') {
    const state = await getEditState(kv, chatId);
    if (state?.kind === 'channel_add' && state.step) {
      return await advanceChannelAdd(kv, chatId, state, '');
    }
    return { text: '当前没有可跳过的步骤', keyboard: mainMenu() };
  }

  // 渠道详情 / 开关 / 删除
  if (data.startsWith('chan:')) {
    const parts = data.split(':');
    const idx = Number(parts[1]);
    const sub = parts[2];
    const cfg = await getConfig(kv);
    const ch = cfg.channels[idx];
    if (!ch) {
      return { text: '渠道不存在', keyboard: channelsListMenu(cfg) };
    }
    if (!sub) {
      return { text: channelDetailText(ch), keyboard: channelDetailMenu(idx, ch.enabled) };
    }
    if (sub === 'toggle') {
      const newCfg = await updateConfig(kv, (c) => {
        if (c.channels[idx]) c.channels[idx].enabled = !c.channels[idx].enabled;
        return c;
      });
      const nch = newCfg.channels[idx];
      return { text: channelDetailText(nch), keyboard: channelDetailMenu(idx, nch.enabled) };
    }
    if (sub === 'del') {
      return {
        text: `确定删除渠道 <b>${escapeHtml(ch.name || ch.id || '')}</b> 吗？`,
        keyboard: kb([
          [{ text: '✅ 确认删除', callback_data: `chan:${idx}:del_yes` }],
          [{ text: '🔙 取消', callback_data: `chan:${idx}` }],
        ]),
      };
    }
    if (sub === 'del_yes') {
      const newCfg = await updateConfig(kv, (c) => {
        c.channels.splice(idx, 1);
        return c;
      });
      return { text: '✅ 渠道已删除', keyboard: channelsListMenu(newCfg) };
    }
  }

  // 规则操作
  if (data.startsWith('rule:')) {
    const parts = data.split(':');
    const ev = parts[1];
    const sub = parts[2];

    if (!ev) {
      return { text: '未知规则', keyboard: mainMenu() };
    }

    if (!sub) {
      const cfg = await getConfig(kv);
      return { text: `📋 规则详情：${ev}`, keyboard: ruleDetailMenu(ev, cfg) };
    }

    if (sub === 'toggle' || sub === 'image' || sub === 'skipepisodes') {
      const newCfg = await updateConfig(kv, (cfg) => {
        if (!cfg.rules[ev]) return cfg;
        if (sub === 'toggle') cfg.rules[ev].enabled = !cfg.rules[ev].enabled;
        if (sub === 'image') cfg.rules[ev].image = !cfg.rules[ev].image;
        if (sub === 'skipepisodes') cfg.rules[ev].skipEpisodes = !cfg.rules[ev].skipEpisodes;
        return cfg;
      });
      const on = sub === 'toggle' ? newCfg.rules[ev].enabled
        : sub === 'image' ? newCfg.rules[ev].image
        : newCfg.rules[ev].skipEpisodes;
      return {
        text: sub === 'toggle'
          ? `${on ? '✅ 已启用' : '⭕ 已禁用'} 该事件通知`
          : sub === 'image'
            ? `${on ? '✅ 带海报' : '⭕ 不带海报'}`
            : `${on ? '✅ 跳过单集' : '⭕ 不跳过单集'}`,
        keyboard: ruleDetailMenu(ev, newCfg),
      };
    }

    if (sub === 'title' || sub === 'body') {
      await setEditState(kv, chatId, { chatId: chatId ?? '', kind: 'rule', event: ev, field: sub });
      return {
        text: sub === 'title'
          ? `✏️ 编辑 <b>${ev}</b> 的标题\n\n请直接回复：\n<code>/set 标题=你要的标题</code>`
          : `✏️ 编辑 <b>${ev}</b> 的正文\n\n请直接回复：\n<code>/set 正文=你要的正文</code>`,
        keyboard: { inline_keyboard: [[{ text: '🔙 返回', callback_data: `rule:${ev}` }]] },
      };
    }
  }

  return { text: '未知操作', keyboard: mainMenu() };
}

/** 发送 TG 消息 */
export async function sendTgMessage(
  botToken: string,
  chatId: string,
  text: string,
  keyboard?: any
): Promise<void> {
  const resp = await fetch(`${TG_API(botToken)}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`sendMessage failed ${resp.status}: ${body.slice(0, 200)}`);
  }
}

/** 编辑 TG 消息 */
export async function editTgMessage(
  botToken: string,
  chatId: string,
  messageId: number,
  text: string,
  keyboard?: any
): Promise<void> {
  const resp = await fetch(`${TG_API(botToken)}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    // 如果内容没变，Telegram 返回 400；这种情况忽略
    if (body.toLowerCase().includes('message is not modified')) return;
    console.error(`editMessageText failed ${resp.status}: ${body.slice(0, 200)}`);
  }
}

/** 回答 callback query */
export async function answerCallbackQuery(botToken: string, queryId: string): Promise<void> {
  const resp = await fetch(`${TG_API(botToken)}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: queryId }),
  });
  if (!resp.ok) {
    console.error(`answerCallbackQuery failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
}

/** 编辑/添加状态（按 chatId 隔离，存 KV，10 分钟过期） */
const EDIT_STATE_PREFIX = 'tg_edit_state:';
const EDIT_STATE_TTL = 600;

export interface EditState {
  chatId: string;
  kind: 'rule' | 'channel_add';
  event?: string;
  field?: 'title' | 'body';
  channelType?: 'telegram' | 'bark' | 'webhook';
  step?: string;
  draft?: Record<string, string>;
}

function editStateKey(chatId: string | null | undefined): string {
  return `${EDIT_STATE_PREFIX}${chatId ?? 'unknown'}`;
}

export async function setEditState(kv: KVNamespace, chatId: string | null | undefined, state: EditState | null): Promise<void> {
  const key = editStateKey(chatId);
  if (!state) {
    await kv.delete(key);
    return;
  }
  await kv.put(key, JSON.stringify(state), { expirationTtl: EDIT_STATE_TTL });
}

export async function getEditState(kv: KVNamespace, chatId: string | null | undefined): Promise<EditState | null> {
  const raw = await kv.get(editStateKey(chatId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EditState;
  } catch {
    return null;
  }
}

/** 添加渠道的分步字段 */
const CHANNEL_STEPS: Record<string, string[]> = {
  telegram: ['bot_token', 'chat_id'],
  bark: ['device_key', 'server_url'],
  webhook: ['endpoint'],
};
/** 可选步骤（可点 ⏭️ 跳过） */
const CHANNEL_OPTIONAL_STEPS = new Set(['server_url']);

const CHANNEL_TYPE_NAMES: Record<string, string> = {
  telegram: 'Telegram',
  bark: 'Bark',
  webhook: 'Webhook',
};

function channelStepPrompt(type: string, step: string): string {
  const prompts: Record<string, string> = {
    bot_token: '请输入 Bot Token：\n<code>/set bot_token=你的token</code>',
    chat_id: '请输入目标 chat_id（频道/群组/个人）：\n<code>/set chat_id=123456</code>',
    device_key: '请输入 Bark device_key：\n<code>/set device_key=xxx</code>',
    server_url: '请输入 Bark 服务器地址（可选，默认 https://api.day.app）：\n<code>/set server_url=https://api.day.app</code>',
    endpoint: '请输入 Webhook 地址：\n<code>/set endpoint=https://...</code>',
  };
  return `➕ 添加 ${CHANNEL_TYPE_NAMES[type] ?? type} 渠道\n\n${prompts[step] ?? step}`;
}

function channelStepKeyboard(step: string): any {
  const rows: TgRow[] = [];
  if (CHANNEL_OPTIONAL_STEPS.has(step)) {
    rows.push([{ text: '⏭️ 跳过此项', callback_data: 'chan:skip' }]);
  }
  rows.push([{ text: '❌ 取消', callback_data: 'channels' }]);
  return kb(rows);
}

/** 校验渠道草稿 */
function validateChannelDraft(type: string, draft: Record<string, string>): string | null {
  if (type === 'telegram') {
    if (!draft.bot_token) return 'bot_token 不能为空';
    if (!draft.chat_id) return 'chat_id 不能为空';
  } else if (type === 'bark') {
    if (!draft.device_key) return 'device_key 不能为空';
  } else if (type === 'webhook') {
    if (!draft.endpoint || !/^https?:\/\//.test(draft.endpoint)) return 'endpoint 必须是 http(s) 地址';
  } else {
    return '未知渠道类型';
  }
  return null;
}

/** 推进添加渠道流程：写入当前步骤的值，返回下一步提示或完成结果 */
async function advanceChannelAdd(
  kv: KVNamespace,
  chatId: string | null | undefined,
  state: EditState,
  value: string
): Promise<{ text: string; keyboard: any } | null> {
  const type = state.channelType ?? '';
  const step = state.step ?? '';
  const draft = { ...(state.draft ?? {}), [step]: value };
  const steps = CHANNEL_STEPS[type] ?? [];
  const next = steps[steps.indexOf(step) + 1];

  if (!next) {
    const err = validateChannelDraft(type, draft);
    if (err) {
      return { text: `❌ ${err}\n\n请重新输入：\n<code>/set ${step}=...</code>`, keyboard: channelStepKeyboard(step) };
    }
    const newCfg = await updateConfig(kv, (cfg) => {
      const n = cfg.channels.length + 1;
      cfg.channels.push({
        id: `ch_${Date.now()}`,
        type: type as any,
        name: `${CHANNEL_TYPE_NAMES[type] ?? type} ${n}`,
        enabled: true,
        config: draft,
        events: ['media_added', 'playback_start', 'playback_stop'],
      });
      return cfg;
    });
    await setEditState(kv, chatId, null);
    return { text: '✅ 渠道已添加（默认订阅全部事件）', keyboard: channelsListMenu(newCfg) };
  }

  await setEditState(kv, chatId, { ...state, step: next, draft });
  return { text: channelStepPrompt(type, next), keyboard: channelStepKeyboard(next) };
}

/** 处理 /set 命令：规则编辑（/set 标题=xxx）或渠道添加分步填写（/set bot_token=xxx） */
export async function handleSetCommand(
  kv: KVNamespace,
  botToken: string,
  chatId: string,
  text: string
): Promise<void> {
  const state = await getEditState(kv, chatId);
  if (!state) return;

  // 去掉 /set 前缀
  const payload = text.replace(/^\/set\s*/, '');
  const m = payload.match(/^([^=]+)=(.+)$/s);
  if (!m) {
    await sendTgMessage(botToken, chatId, '格式不对。请用：\n<code>/set 字段名=值</code>');
    return;
  }
  const [, fieldNameRaw, valueRaw] = m;
  const fieldName = fieldNameRaw.trim();
  const value = valueRaw.trim();

  // 渠道添加流程
  if (state.kind === 'channel_add') {
    if (fieldName !== state.step) {
      await sendTgMessage(botToken, chatId, `请按提示填写当前步骤：\n<code>/set ${state.step}=...</code>`, channelStepKeyboard(state.step ?? ''));
      return;
    }
    const result = await advanceChannelAdd(kv, chatId, state, value);
    if (result) {
      await sendTgMessage(botToken, chatId, result.text, result.keyboard);
    }
    return;
  }

  // 规则编辑流程（兼容无 kind 的老状态）
  const field = fieldName.includes('标题') ? 'titleTemplate'
    : fieldName.includes('正文') ? 'bodyTemplate'
    : null;

  if (!field) {
    await sendTgMessage(botToken, chatId, '只支持「标题」或「正文」');
    return;
  }

  const newCfg = await updateConfig(kv, (cfg) => {
    if (!cfg.rules[state.event ?? '']) return cfg;
    cfg.rules[state.event ?? ''][field] = value;
    return cfg;
  });

  await setEditState(kv, chatId, null);
  await sendTgMessage(
    botToken,
    chatId,
    `✅ ${field === 'titleTemplate' ? '标题' : '正文'} 已更新`,
    ruleDetailMenu(state.event ?? '', newCfg)
  );
}
