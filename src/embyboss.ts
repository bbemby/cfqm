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
    console.log('白名单查询跳过');
    return { whitelist: false, privacy_mode: false };
  }
  try {
    const url = new URL(`${embybossApiUrl.replace(/\/$/, '')}/user/whitelist`);
    url.searchParams.set('emby_id', embyUserId);
    url.searchParams.set('token', embybossBotToken);
    // 日志脱敏：token 打码；emby_id 本身就是用户名，同样脱敏
    const logUrl = new URL(url.toString());
    logUrl.searchParams.set('token', '***');
    logUrl.searchParams.set('emby_id', maskName(embyUserId));
    console.log('查白名单:', logUrl.toString());
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

/** 用户名脱敏：保留首字，其余替换为 *；单字用户名整体替换为 *。
 *  按 code point 切分，emoji 开头不会切出半个代理对。 */
function maskName(name: string): string {
  if (!name) return name;
  const chars = Array.from(name);
  if (chars.length === 1) return '*';
  return chars[0] + '*'.repeat(chars.length - 1);
}

/** 获取显示名：白名单加尊称，并支持隐私模式脱敏 */
export async function getDisplayName(
  embybossApiUrl: string,
  embybossBotToken: string,
  whitelistTitle: string,
  embyUserId: string,
  originalName: string
): Promise<string> {
  // 日志只写脱敏后的名字：调用方传的 embyUserId 本身就是用户名，原样打日志等于隐私模式失效
  console.log('getDisplayName:', { embybossApiUrl, embyUserId: maskName(embyUserId), name: maskName(originalName) });
  if (!embybossApiUrl || !embyUserId) return `用户：${originalName}`;
  try {
    const result = await checkWhitelist(embybossApiUrl, embybossBotToken, embyUserId);
    console.log('白名单查询结果:', result);
    if (result.whitelist) {
      const displayName = result.privacy_mode ? maskName(originalName) : originalName;
      const finalName = `🔱👑【${whitelistTitle}】👑🔱\n用户：${displayName}`;
      console.log('最终显示名用户:', maskName(displayName));
      return finalName;
    }
  } catch (e) {
    console.log('getDisplayName 异常:', e);
  }
  return `用户：${originalName}`;
}
