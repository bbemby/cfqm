/** Emby webhook 解析 */

import { EmbyEvent, EventType } from './types';

const EVENT_MAP: Record<string, EventType> = {
  'item.added': 'media_added',
  'library.new': 'media_added',
  'library.media.added': 'media_added',
  'PlaybackStart': 'playback_start',
  'playback.start': 'playback_start',
  'PlaybackStop': 'playback_stop',
  'playback.stop': 'playback_stop',
};

function ticksToStr(ticks: unknown): string {
  const t = Number(ticks);
  if (!t || t <= 0 || isNaN(t)) return '0';
  const seconds = t / 10_000_000;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function progressPct(pos: unknown, dur: unknown): string {
  const p = Number(pos), d = Number(dur);
  if (!d || d <= 0 || isNaN(p) || isNaN(d)) return '0';
  return String(Math.min(100, Math.round((p / d) * 100)));
}

export function parseEmbyWebhook(payload: any): EmbyEvent | null {
  const rawEvent = String(payload?.Event ?? '').trim();
  const type = EVENT_MAP[rawEvent];
  if (!type) return null;

  const item = payload?.Item ?? {};
  const session = payload?.Session ?? {};
  const user = payload?.User ?? {};

  const itemId = String(item.Id ?? '');
  const title = String(item.Name ?? '');
  const userId = String(user.Id ?? user.UserId ?? '');
  const userName = String(session.UserName ?? user.Name ?? '');

  // 设备名从 Session 或 Title 提取
  let deviceName = String(session.DeviceName ?? '');
  let client = String(session.Client ?? '');
  if (!deviceName) {
    const titleStr = String(payload?.Title ?? '');
    if (titleStr.includes(' 上 ')) {
      deviceName = titleStr.split(' 上 ')[0];
    }
  }
  // client 兜底：从 device 括号提取
  if (!client && deviceName.includes('(') && deviceName.endsWith(')')) {
    const m = deviceName.match(/\(([^)]+)\)$/);
    if (m) {
      client = m[1];
      deviceName = deviceName.replace(/\s*\([^)]+\)$/, '');
    }
  }

  const posTicks = payload?.PositionTicks ?? 0;
  const runTicks = payload?.RunTimeTicks ?? item.RunTimeTicks ?? 0;

  // Emby 的 library 字段可能放在不同位置
  const library = Array.isArray(item.CollectionFolders) && item.CollectionFolders.length
    ? String(item.CollectionFolders[0].Name ?? item.CollectionFolders[0])
    : String(item.CollectionFolder ?? item.Parent ?? '');

  return {
    type,
    title,
    userId,
    userName,
    deviceId: String(session.DeviceId ?? ''),
    deviceName,
    client,
    itemId,
    year: String(item.ProductionYear ?? ''),
    library,
    position: ticksToStr(posTicks),
    duration: ticksToStr(runTicks),
    progress: type === 'playback_stop' ? progressPct(posTicks, runTicks) : '',
  };
}

/** 渲染模板：{{var}} 替换 */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

/** 构造海报 URL */
export function buildPosterUrl(serverUrl: string, apiKey: string, itemId: string): string {
  if (!serverUrl || !itemId) return '';
  const url = `${serverUrl.replace(/\/$/, '')}/Items/${itemId}/Images/Primary?maxHeight=400`;
  return apiKey ? `${url}&api_key=${encodeURIComponent(apiKey)}` : url;
}
