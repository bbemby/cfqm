/** embyboss 联动：查白名单用户 */

const FETCH_TIMEOUT_MS = 3000;

export async function checkWhitelist(
  embybossApiUrl: string,
  embybossBotToken: string,
  embyUserId: string
): Promise<boolean> {
  if (!embybossApiUrl || !embyUserId) {
    console.log('白名单查询跳过:', { embybossApiUrl, embyUserId });
    return false;
  }
  try {
    const url = new URL(`${embybossApiUrl.replace(/\/$/, '')}/user/whitelist`);
    url.searchParams.set('emby_id', embyUserId);
    url.searchParams.set('token', embybossBotToken);
    console.log('查白名单:', url.toString());
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    console.log('白名单响应:', resp.status);
    if (!resp.ok) return false;
    const data = await resp.json() as { whitelist?: boolean };
    console.log('白名单结果:', data);
    return data.whitelist === true;
  } catch (e) {
    console.log('白名单异常:', e);
    return false; // 容错降级
  }
}

/** 获取显示名：白名单加尊称 */
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
    if (await checkWhitelist(embybossApiUrl, embybossBotToken, embyUserId)) {
      return `${whitelistTitle}：${originalName}`;
    }
  } catch {
    // 降级
  }
  return `用户：${originalName}`;
}
