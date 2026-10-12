import type { Fetch } from "./types.js";

export interface HttpOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

const UA = "project-matrix-watch/0.1 (+https://github.com/NeOMakinG/project-matrix)";

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`GET ${url} -> ${status}`);
  }
}

export async function getText(url: string, opts: HttpOptions = {}): Promise<string> {
  const f = opts.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await f(url, {
      headers: { "user-agent": UA, ...opts.headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new HttpError(url, res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  return JSON.parse(
    await getText(url, { ...opts, headers: { accept: "application/json", ...opts.headers } }),
  ) as T;
}
