/** embyboss 联动：查白名单用户 */

const FETCH_TIMEOUT_MS = 3000;

export interface WhitelistResult {
  whitelist: boolean;
  privacy_mode: boolean;
}

export async function checkWhitelist(
  embybossApiUrl: string,
  embybossBotToken: string,
  embyUserId: string
): Promise<WhitelistResult> {
  if (!embybossApiUrl || !embyUserId) {
    console.log('白名单查询跳过:', { embybossApiUrl, embyUserId });
    return { whitelist: false, privacy_mode: false };
  }
  try {
    const url = new URL(`${embybossApiUrl.replace(/\/$/, '')}/user/whitelist`);
    url.searchParams.set('emby_id', embyUserId);
    url.searchParams.set('token', embybossBotToken);
    console.log('查白名单:', url.toString());
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    console.log('白名单响应:', resp.status);
    if (!resp.ok) return { whitelist: false, privacy_mode: false };
    const data = await resp.json() as { whitelist?: boolean; privacy_mode?: boolean };
    console.log('白名单结果:', data);
    return {
      whitelist: data.whitelist === true,
      privacy_mode: data.privacy_mode === true,
    };
  } catch (e) {
    console.log('白名单异常:', e);
    return { whitelist: false, privacy_mode: false }; // 容错降级
  }
}

/** 用户名脱敏：保留首字，其余替换为 *；单字用户名整体替换为 * */
function maskName(name: string): string {
  if (!name) return name;
  if (name.length === 1) return '*';
  return name[0] + '*'.repeat(name.length - 1);
}

/** 获取显示名：白名单加尊称，并支持隐私模式脱敏 */
export async function getDisplayName(
  embybossApiUrl: string,
  embybossBotToken: string,
  whitelistTitle: string,
  embyUserId: string,
  originalName: string
): Promise<string> {
  console.log('getDisplayName:', { embybossApiUrl, embyUserId, originalName });
  if (!embybossApiUrl || !embyUserId) return `用户：${originalName}`;
  try {
    const result = await checkWhitelist(embybossApiUrl, embybossBotToken, embyUserId);
    if (result.whitelist) {
      const displayName = result.privacy_mode ? maskName(originalName) : originalName;
      return `${whitelistTitle}：${displayName}`;
    }
  } catch {
    // 降级
  }
  return `用户：${originalName}`;
}
