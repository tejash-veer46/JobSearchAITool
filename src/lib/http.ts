const USER_AGENT = 'JobApplyAI/0.1 (personal job search tool)';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

// One queue per host, so requests to the same site are spaced out even when
// callers run in parallel.
const hostQueues = new Map<string, Promise<void>>();

function throttle(host: string, minIntervalMs: number): Promise<void> {
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const next = previous.then(() => new Promise<void>((r) => setTimeout(r, minIntervalMs)));
  hostQueues.set(host, next);
  return previous;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchOptions {
  minIntervalMs?: number;
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** GET a JSON document with per-host rate limiting and retries on 429/5xx/network errors. */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { minIntervalMs = 700, retries = 3, timeoutMs = 20_000, headers = {} } = opts;
  const host = new URL(url).host;

  for (let attempt = 0; ; attempt++) {
    await throttle(host, minIntervalMs);
    let status = 0;
    let retryAfterMs = 0;
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return (await res.json()) as T;
      status = res.status;
      retryAfterMs = Number(res.headers.get('retry-after')) * 1000 || 0;
      if (status !== 429 && status < 500) throw new HttpError(status, url);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (attempt >= retries) throw err;
    }
    if (attempt >= retries) throw new HttpError(status, url);
    await sleep(Math.max(retryAfterMs, 1000 * 2 ** attempt + Math.random() * 500));
  }
}
