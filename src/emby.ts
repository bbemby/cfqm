/** Emby webhook 解析 */

import { EmbyEvent, EventType } from './types';
import { fetchWithTimeout } from './http';

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
  const seriesId = String(item.SeriesId ?? '');
  const title = String(item.Name ?? '');
  const userId = String(user.Id ?? session.UserId ?? user.UserId ?? '');
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

  const playbackInfo = payload?.PlaybackInfo ?? {};
  const posTicks = payload?.PlaybackPositionTicks
    ?? payload?.PositionTicks
    ?? playbackInfo.PositionTicks
    ?? item.PositionTicks
    ?? item.UserData?.PlaybackPositionTicks
    ?? 0;
  const runTicks = payload?.RunTimeTicks
    ?? playbackInfo.RunTimeTicks
    ?? item.RunTimeTicks
    ?? 0;

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
    seriesId,
    itemType: String(item.Type ?? ''),
    year: String(item.ProductionYear ?? ''),
    library,
    position: ticksToStr(posTicks),
    duration: ticksToStr(runTicks),
    progress: type === 'playback_stop' ? progressPct(posTicks, runTicks) : '',
  };
}

/** 渲染模板：{{var}} 替换。单次正则替换 + 函数返回值，避免两点旧毛病：
 *  1) replaceAll 字符串替换会把值里的 $&、$' 等当成替换模式；
 *  2) 逐个变量替换时，值里若含后续变量名会被二次替换。 */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** 构造海报 URL（仅 Worker 内使用：TG 路径下载后上传，不外发；Bark/Webhook 已不再接收图片） */
export function buildPosterUrl(serverUrl: string, apiKey: string, itemId: string): string {
  if (!serverUrl || !itemId) return '';
  const url = `${serverUrl.replace(/\/$/, '')}/Items/${encodeURIComponent(itemId)}/Images/Primary?maxHeight=400`;
  return apiKey ? `${url}&api_key=${encodeURIComponent(apiKey)}` : url;
}

/** 解析最优海报 URL：本集/本片自己有 Primary 就用自己的；分集没有自带海报
 *  （AI 短剧这类只有剧集级 poster.jpg 的分集）时退到剧集 Primary；Emby 查询失败时
 *  退回老行为（本集 Primary，取不到时 TG 层降级纯文本，不丢通知）。
 *  注意：本服裸 /Items/{id} 不通（代理 404），详情必须走 /Users/{userId}/Items/{id}。 */
export async function resolvePosterUrl(
  serverUrl: string,
  apiKey: string,
  itemId: string,
  userId = '',
  seriesIdHint = '',
): Promise<string> {
  if (!serverUrl || !itemId) return '';
  const own = buildPosterUrl(serverUrl, apiKey, itemId);
  const seriesUrl = (sid: string) => buildPosterUrl(serverUrl, apiKey, sid);
  if (!apiKey || !userId) return seriesIdHint ? seriesUrl(seriesIdHint) : own;
  try {
    const detailUrl = `${serverUrl.replace(/\/$/, '')}/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}?api_key=${encodeURIComponent(apiKey)}&Fields=SeriesId,ImageTags`;
    const resp = await fetchWithTimeout(detailUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!resp.ok) return seriesIdHint ? seriesUrl(seriesIdHint) : own;
    const item: any = await resp.json();
    if (item?.ImageTags?.Primary) return own;
    const seriesId = String(item?.SeriesId ?? seriesIdHint ?? '');
    if (seriesId) return seriesUrl(seriesId);
    return own;
  } catch {
    return seriesIdHint ? seriesUrl(seriesIdHint) : own;
  }
}
