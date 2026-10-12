import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Fetch } from "./types.js";

export interface HttpOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Max response body in bytes (default 2 MB). */
  maxBytes?: number;
  maxRedirects?: number;
  /** Resolves a host to its addresses; default is the system resolver. Injected in tests. */
  resolve?: (host: string) => Promise<string[]>;
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

export class BlockedUrlError extends Error {}

function ipv4Blocked(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, includes Tailscale
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6Blocked(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::" || v === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return ipv4Blocked(mapped[1]!);
  return /^(fc|fd|fe[89ab]|ff)/.test(v) || v.startsWith("64:ff9b:") || v.startsWith("2001:db8:");
}

export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, ""));
  if (kind === 4) return ipv4Blocked(ip);
  if (kind === 6) return ipv6Blocked(ip);
  return true;
}

const BLOCKED_SUFFIX = /(^|\.)(localhost|local|internal|lan|home|ts\.net|tailscale\.net)$/i;

const systemResolve = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Refuses non-HTTP(S) URLs, private/loopback/link-local/CGNAT (tailnet) targets and internal host
 * names, checked after DNS resolution. Note: the fetch re-resolves, so a rebinding resolver could still
 * race this check; feeds are low value, and the gateway is never reached through this path.
 */
export async function assertPublicUrl(
  url: string,
  resolve: (host: string) => Promise<string[]> = systemResolve,
) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BlockedUrlError(`invalid url ${url}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new BlockedUrlError(`protocol ${u.protocol} not allowed`);
  if (u.username || u.password) throw new BlockedUrlError("credentials in url not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_SUFFIX.test(host)) throw new BlockedUrlError(`internal host ${host}`);
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (!addresses.length) throw new BlockedUrlError(`${host} does not resolve`);
  const bad = addresses.find(isBlockedAddress);
  if (bad) throw new BlockedUrlError(`${host} resolves to non-public address ${bad}`);
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
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

/** GET with SSRF checks on every hop, manual redirects, a size cap and a timeout. */
export async function getText(url: string, opts: HttpOptions = {}): Promise<string> {
  const f = opts.fetch ?? fetch;
  const maxRedirects = opts.maxRedirects ?? 3;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      await assertPublicUrl(current, opts.resolve);
      const res = await f(current, {
        headers: { "user-agent": UA, ...opts.headers },
        signal: controller.signal,
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop >= maxRedirects) throw new HttpError(current, res.status);
        current = new URL(res.headers.get("location")!, current).toString();
        continue;
      }
      if (!res.ok) throw new HttpError(current, res.status);
      return await readCapped(res, opts.maxBytes ?? 2_000_000, current);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  return JSON.parse(
    await getText(url, { ...opts, headers: { accept: "application/json", ...opts.headers } }),
  ) as T;
}
