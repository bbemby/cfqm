/** 播放开始去重：D1 替代 KV。
 * KV 写额度每天 1000 次已超（11/5 写 1118、11/6 写 1139），D1 写额度每天 10 万行。
 * 语义与原来一致：同一 key 60 秒内只通知一次；去重读写失败不阻塞通知。
 */

const DEDUP_WINDOW_MS = 60 * 1000;
const CLEANUP_AFTER_MS = 60 * 60 * 1000; // 顺手清掉 1 小时前的旧记录，表一直很小

export async function isDuplicatePlayback(db: D1Database, key: string, now: number): Promise<boolean> {
  const row = await db.prepare('SELECT ts FROM dedup WHERE key = ?1').bind(key).first<{ ts: number }>();
  return !!row && now - row.ts < DEDUP_WINDOW_MS;
}

export async function markPlayback(db: D1Database, key: string, now: number): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO dedup(key, ts) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts').bind(key, now),
    db.prepare('DELETE FROM dedup WHERE ts < ?1').bind(now - CLEANUP_AFTER_MS),
  ]);
}
