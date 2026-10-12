import http from "node:http";
import https from "node:https";
import tls from "node:tls";

export interface PinnedRequest {
  url: URL;
  /** The vetted IP the connection must use. */
  address: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

export interface PinnedResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
}

/** Sends one request to exactly `address`, verifying TLS against the URL's real hostname. */
export type Transport = (req: PinnedRequest) => Promise<PinnedResponse>;

const family = (ip: string) => (ip.includes(":") ? 6 : 4);

/** Bun: native fetch to the IP, with Host header and an explicit certificate check for the hostname. */
const bunTransport: Transport = async (req) => {
  const target = new URL(req.url);
  target.hostname = family(req.address) === 6 ? `[${req.address}]` : req.address;
  const host = req.url.hostname;
  const res = await fetch(target, {
    method: req.method,
    headers: { ...req.headers, host: req.url.host },
    ...(req.body !== undefined ? { body: req.body } : {}),
    signal: req.signal,
    redirect: "manual",
    ...(req.url.protocol === "https:"
      ? {
          tls: {
            serverName: host,
            checkServerIdentity: (_name: string, cert: tls.PeerCertificate) =>
              tls.checkServerIdentity(host, cert),
          },
        }
      : {}),
  } as RequestInit);
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: res.body };
};

/** Node: http(s).request to the hostname (so TLS verifies it), with DNS replaced by the vetted IP. */
const nodeTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const mod = req.url.protocol === "https:" ? https : http;
    const lookup = (_h: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
      if (opts?.all) cb(null, [{ address: req.address, family: family(req.address) }]);
      else cb(null, req.address, family(req.address));
    };
    const r = mod.request(
      req.url,
      { method: req.method, headers: req.headers, lookup: lookup as never, signal: req.signal },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers[k] = v;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            res.on("end", () => controller.close());
            res.on("error", (e) => controller.error(e));
          },
          cancel() {
            res.destroy();
          },
        });
        resolve({ status: res.statusCode ?? 0, headers, body });
      },
    );
    r.on("error", reject);
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });

export const defaultTransport: Transport =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? bunTransport : nodeTransport;

/** Testing only: adapts a fetch-like function. It does NOT pin the address. */
export function fetchTransport(
  f: (url: string, init?: RequestInit) => Promise<Response>,
): Transport {
  return async (req) => {
    const res = await f(req.url.toString(), {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      signal: req.signal,
      redirect: "manual",
    });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: res.body,
    };
  };
}
