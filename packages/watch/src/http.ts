import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicAddress } from "./net-guard.js";
import { defaultTransport, type PinnedResponse, type Transport } from "./transport.js";

export interface HttpOptions {
  /** How requests are sent; the default pins the connection to the vetted IP. Tests inject one. */
  transport?: Transport;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Max response body in bytes (default 2 MB). */
  maxBytes?: number;
  maxRedirects?: number;
  /** Resolves a host to its addresses; default is the system resolver. */
  resolve?: (host: string) => Promise<string[]>;
}

const UA = "project-matrix-watch/0.1 (+https://github.com/NeOMakinG/project-matrix)";

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${url} -> ${status}`);
  }
}

export class BlockedUrlError extends Error {}

export const isBlockedAddress = (ip: string) => !isPublicAddress(ip);

const BLOCKED_SUFFIX = /(^|\.)(localhost|local|internal|lan|home|arpa|ts\.net|tailscale\.net)$/i;

const systemResolve = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Validates a URL and returns the one vetted address to connect to. Every resolved address must be
 * public unicast (embedded IPv4 in mapped/NAT64/6to4 forms is checked too); the caller pins the
 * connection to the returned address, so DNS cannot change the target afterwards.
 */
export async function vetUrl(
  url: string,
  resolve: (host: string) => Promise<string[]> = systemResolve,
  timeoutMs = 5_000,
): Promise<{ url: URL; address: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BlockedUrlError(`invalid url ${url}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new BlockedUrlError(`protocol ${u.protocol} not allowed`);
  if (u.username || u.password) throw new BlockedUrlError("credentials in url not allowed");
  // WHATWG URL parsing already normalises hex/octal/integer IPv4 and IPv6 forms in `hostname`.
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_SUFFIX.test(host)) throw new BlockedUrlError(`internal host ${host}`);
  const addresses = isIP(host)
    ? [host]
    : await withTimeout(resolve(host), timeoutMs, `DNS lookup of ${host}`);
  if (!addresses.length) throw new BlockedUrlError(`${host} does not resolve`);
  const bad = addresses.find(isBlockedAddress);
  if (bad) throw new BlockedUrlError(`${host} resolves to non-public address ${bad}`);
  return { url: u, address: addresses[0]! };
}

/** Kept for callers that only need the check. */
export async function assertPublicUrl(url: string, resolve?: (host: string) => Promise<string[]>) {
  await vetUrl(url, resolve);
}

async function readCapped(res: PinnedResponse, maxBytes: number, url: string): Promise<string> {
  const declared = Number(res.headers["content-length"] ?? "0");
  if (declared > maxBytes) throw new Error(`${url} body ${declared} bytes exceeds ${maxBytes}`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${url} body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** One request with SSRF vetting and IP pinning on every hop, manual redirects, size cap and timeout. */
export async function request(
  url: string,
  opts: HttpOptions & { method?: "GET" | "POST"; body?: string } = {},
): Promise<string> {
  const transport = opts.transport ?? defaultTransport;
  const maxRedirects = opts.maxRedirects ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    let method = opts.method ?? "GET";
    let body = opts.body;
    for (let hop = 0; ; hop++) {
      const vetted = await vetUrl(current, opts.resolve, Math.min(timeoutMs, 5_000));
      const res = await transport({
        url: vetted.url,
        address: vetted.address,
        method,
        headers: { "user-agent": UA, ...opts.headers },
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= maxRedirects) throw new HttpError(current, res.status);
        current = new URL(location, current).toString();
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => {});
        throw new HttpError(current, res.status);
      }
      return await readCapped(res, opts.maxBytes ?? 2_000_000, current);
    }
  } finally {
    clearTimeout(timer);
  }
}

export const getText = (url: string, opts: HttpOptions = {}) => request(url, opts);

export async function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  return JSON.parse(
    await request(url, { ...opts, headers: { accept: "application/json", ...opts.headers } }),
  ) as T;
}

export async function postJson<T = unknown>(
  url: string,
  payload: unknown,
  opts: HttpOptions = {},
): Promise<T> {
  return JSON.parse(
    await request(url, {
      ...opts,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json", accept: "application/json", ...opts.headers },
    }),
  ) as T;
}
