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
  return kb([
    [{ text: `${on} 总开关`, callback_data: `rule:${ev}:toggle` }],
    [{ text: `✏️ 标题: ${tShow}`, callback_data: `rule:${ev}:title` }],
    [{ text: `✏️ 正文: ${bShow}`, callback_data: `rule:${ev}:body` }],
    [{ text: `${img} 带海报`, callback_data: `rule:${ev}:image` }],
    [{ text: '🔙 返回规则列表', callback_data: 'rules' }],
  ]);
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
  rows.push([{ text: '🔙 返回', callback_data: 'main' }]);
  return kb(rows);
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

    if (sub === 'toggle' || sub === 'image') {
      const newCfg = await updateConfig(kv, (cfg) => {
        if (!cfg.rules[ev]) return cfg;
        if (sub === 'toggle') cfg.rules[ev].enabled = !cfg.rules[ev].enabled;
        if (sub === 'image') cfg.rules[ev].image = !cfg.rules[ev].image;
        return cfg;
      });
      const on = sub === 'toggle' ? newCfg.rules[ev].enabled : newCfg.rules[ev].image;
      return {
        text: sub === 'toggle'
          ? `${on ? '✅ 已启用' : '⭕ 已禁用'} 该事件通知`
          : `${on ? '✅ 带海报' : '⭕ 不带海报'}`,
        keyboard: ruleDetailMenu(ev, newCfg),
      };
    }

    if (sub === 'title' || sub === 'body') {
      await setEditState(kv, chatId, { chatId: chatId ?? '', event: ev, field: sub });
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

/** 规则编辑状态（按 chatId 隔离，存 KV） */
const EDIT_STATE_PREFIX = 'tg_edit_state:';

export interface EditState {
  chatId: string;
  event: string;
  field: 'title' | 'body';
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
  await kv.put(key, JSON.stringify(state));
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

/** 处理 /set 命令，例如：/set title=🎬 新片入库 */
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
    await sendTgMessage(botToken, chatId, '格式不对。请用：\n<code>/set 标题=新标题</code>\n或\n<code>/set 正文=新正文</code>', { inline_keyboard: [[{ text: '🔙 返回', callback_data: `rule:${state.event}` }]] });
    return;
  }

  const [, fieldName, value] = m;
  const field = fieldName.includes('标题') ? 'titleTemplate'
    : fieldName.includes('正文') ? 'bodyTemplate'
    : null;

  if (!field) {
    await sendTgMessage(botToken, chatId, '只支持「标题」或「正文」');
    return;
  }

  const newCfg = await updateConfig(kv, (cfg) => {
    if (!cfg.rules[state.event]) return cfg;
    cfg.rules[state.event][field] = value.trim();
    return cfg;
  });

  await setEditState(kv, chatId, null);
  await sendTgMessage(
    botToken,
    chatId,
    `✅ ${field === 'titleTemplate' ? '标题' : '正文'} 已更新`,
    ruleDetailMenu(state.event, newCfg)
  );
}
