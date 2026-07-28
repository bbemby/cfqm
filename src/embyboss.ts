/** embyboss 联动：查白名单用户 */

export async function checkWhitelist(
  embybossApiUrl: string,
  embyUserId: string
): Promise<boolean> {
  if (!embybossApiUrl || !embyUserId) return false;
  try {
    const resp = await fetch(
      `${embybossApiUrl.replace(/\/$/, '')}/api/whitelist?emby_id=${encodeURIComponent(embyUserId)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!resp.ok) return false;
    const data = await resp.json() as { whitelist?: boolean };
    return data.whitelist === true;
  } catch {
    return false; // 容错降级
  }
}

/** 获取显示名：白名单加尊称 */
export async function getDisplayName(
  embybossApiUrl: string,
  whitelistTitle: string,
  embyUserId: string,
  originalName: string
): Promise<string> {
  if (!embybossApiUrl || !embyUserId) return `用户：${originalName}`;
  try {
    if (await checkWhitelist(embybossApiUrl, embyUserId)) {
      return `${whitelistTitle}：${originalName}`;
    }
  } catch {
    // 降级
  }
  return `用户：${originalName}`;
}
