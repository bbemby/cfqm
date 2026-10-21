/** 带超时的 fetch：Cloudflare Workers 不给 fetch 默认超时，下游挂住会拖满执行时长 */

export const FETCH_TIMEOUT_MS = 5000;

/** 所有对外请求统一走这个，超时即 Abort */
export function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  ms: number = FETCH_TIMEOUT_MS
): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
}

/** 给没有信号的异步操作（如 blob 读取）配超时 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'timeout'): Promise<T> {
  let timer: any;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
