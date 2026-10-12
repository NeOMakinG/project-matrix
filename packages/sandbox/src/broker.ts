import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkPolicy } from "@matrix/core";
import { type CredentialSource, resolveCredential } from "./credentials.js";
import { isPrivateAddress } from "./ip.js";
import { asRunToken, type RunToken } from "./launch.js";
import { secretNeedles } from "./secret-gate.js";

/** Routes a sandbox may call on the model gateway. Everything else is answered 403 and never forwarded. */
export const DEFAULT_LLM_ROUTES: Array<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/v1\/messages$/ },
  { method: "POST", path: /^\/v1\/messages\/count_tokens$/ },
  { method: "GET", path: /^\/v1\/models$/ },
  { method: "POST", path: /^\/v1\/chat\/completions$/ },
  { method: "POST", path: /^\/v1\/responses$/ },
];

const STRIPPED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "proxy-connection",
  "host",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

export interface BrokerOptions {
  /** HTTP(S) origin or custom mount, optionally ending in `/v1/`. Client API paths retain `/v1`. */
  gatewayUrl: string;
  gatewayKey: CredentialSource;
  llmRoutes?: Array<{ method: string; path: RegExp }>;
  /** Parent directory for per-run socket directories. */
  socketRoot?: string;
  maxBodyBytes?: number;
}

export interface GrantRequest {
  runId: string;
  network: NetworkPolicy;
  allowHosts?: string[];
  allowPorts?: number[];
  /** Allow tunnels to private, loopback, link-local or tailnet addresses. Off by default. */
  allowPrivate?: boolean;
}

/** A per-run grant: its own socket directory, mounted only into that run's sandbox. */
export interface Grant {
  runId: string;
  /** Directory holding `llm.sock` and, for allowlist runs, `egress.sock`. Undefined for network "none". */
  socketDir?: string;
  /** Run token the sandbox presents to the LLM socket. Worthless outside this grant. */
  token: RunToken;
  network: NetworkPolicy;
  close(): Promise<void>;
}

export function hostAllowed(host: string, allowHosts: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowHosts.some((rule) => {
    const r = rule.toLowerCase();
    if (r.startsWith("*.")) return h.endsWith(r.slice(1)) && h.length > r.length - 1;
    return h === r;
  });
}

function sameToken(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(req: http.IncomingMessage): string | undefined {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string") return apiKey;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer "))
    return auth.slice(7).trim();
  return undefined;
}

function deny(res: http.ServerResponse, code: number, message: string) {
  res.writeHead(code, { "content-type": "text/plain", connection: "close" });
  res.end(message);
}

/**
 * Holds real credentials on the host and serves per-run unix sockets:
 * - `llm.sock`: HTTP-aware gateway proxy. Checks the route and the run token, replaces auth headers
 *   with the real gateway key, streams the response (SSE included).
 * - `egress.sock`: HTTP CONNECT proxy that only tunnels to allowlisted hosts and ports.
 */
export class CredentialBroker {
  readonly #options: BrokerOptions;
  readonly #upstream: URL;
  readonly #mountPrefix: string;
  #key: string | undefined;
  readonly #grants = new Map<string, Grant>();

  constructor(options: BrokerOptions) {
    this.#options = options;
    this.#upstream = new URL(options.gatewayUrl);
    const base = /^https?:\/\/[^/?#]*(\/[^?#]*)?$/i.exec(options.gatewayUrl);
    const rawPath = base?.[1] ?? "/";
    const segments = rawPath.replace(/^\//, "").replace(/\/$/, "").split("/").filter(Boolean);
    if (
      !base ||
      !["http:", "https:"].includes(this.#upstream.protocol) ||
      this.#upstream.username ||
      this.#upstream.password ||
      /[\\\s?#]/.test(options.gatewayUrl) ||
      !/^\/(?:[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*\/?)?$/.test(rawPath) ||
      segments.some(
        (segment, index) =>
          segment === "." ||
          segment === ".." ||
          (/^v\d+$/i.test(segment) && !(segment === "v1" && index === segments.length - 1)),
      )
    )
      throw new Error("unsupported gateway base; use an HTTP(S) origin or unescaped mount[/v1]");
    this.#mountPrefix = rawPath.replace(/\/$/, "").replace(/\/v1$/, "");
  }

  async #gatewayKey(): Promise<string> {
    this.#key ??= await resolveCredential(this.#options.gatewayKey);
    return this.#key;
  }

  /** Known secret values, so secret gates can scan for them without logging them. */
  async secretValues(): Promise<string[]> {
    return [await this.#gatewayKey()];
  }

  /** Throws if any value carries a real credential (raw, base64 or hex). Called before every launch. */
  async assertNoSecrets(values: string[]): Promise<void> {
    const needles = (await this.secretValues()).flatMap((v) => secretNeedles(v));
    for (const value of values) {
      const buf = Buffer.from(value);
      if (needles.some((n) => buf.includes(n))) {
        throw new Error("refusing to place a real gateway credential inside a sandbox");
      }
    }
  }

  async grant(request: GrantRequest): Promise<Grant> {
    if (this.#grants.has(request.runId))
      throw new Error(`grant already open for run ${request.runId}`);
    const token = asRunToken(`mxr_${randomBytes(24).toString("hex")}`);
    if (request.network === "none") {
      const grant: Grant = { runId: request.runId, token, network: "none", close: async () => {} };
      return grant;
    }
    const key = await this.#gatewayKey();
    // Unix socket paths are limited to ~104 bytes, so prefer a short root over os.tmpdir().
    const root =
      this.#options.socketRoot ?? (process.platform === "win32" ? tmpdir() : "/tmp/matrix-sockets");
    await mkdir(root, { recursive: true });
    const socketDir = await mkdtemp(
      join(root, `mx-${request.runId.replace(/[^a-zA-Z0-9_-]/g, "")}-`),
    );
    await chmod(socketDir, 0o700);
    const servers: Array<http.Server> = [this.#llmServer(token, key)];
    await listen(servers[0] as http.Server, join(socketDir, "llm.sock"));
    if (request.network === "allowlist") {
      const egress = this.#egressServer(
        request.allowHosts ?? [],
        request.allowPorts ?? [443],
        request.allowPrivate ?? false,
      );
      servers.push(egress);
      await listen(egress, join(socketDir, "egress.sock"));
    }
    const grant: Grant = {
      runId: request.runId,
      socketDir,
      token,
      network: request.network,
      close: async () => {
        this.#grants.delete(request.runId);
        await Promise.all(
          servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
        );
        await rm(socketDir, { recursive: true, force: true });
      },
    };
    this.#grants.set(request.runId, grant);
    return grant;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#grants.values()].map((g) => g.close()));
  }

  #llmServer(token: string, key: string): http.Server {
    const routes = this.#options.llmRoutes ?? DEFAULT_LLM_ROUTES;
    const upstream = this.#upstream;
    const client = upstream.protocol === "https:" ? https : http;
    const maxBody = this.#options.maxBodyBytes ?? 32 * 1024 * 1024;
    const server = http.createServer((req, res) => {
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      if (!routes.some((r) => r.method === method && r.path.test(path))) {
        deny(res, 403, `blocked by matrix broker: ${method} ${path}`);
        req.resume();
        return;
      }
      if (!sameToken(presentedToken(req), token)) {
        deny(res, 401, "invalid run token");
        req.resume();
        return;
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > maxBody) {
        deny(res, 413, "body too large");
        req.resume();
        return;
      }
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!STRIPPED_HEADERS.has(name) && value !== undefined) headers[name] = value;
      }
      headers.authorization = `Bearer ${key}`;
      headers["x-api-key"] = key;
      headers.host = upstream.host;
      const forward = client.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port,
          method,
          path: `${this.#mountPrefix}${req.url ?? "/"}`,
          headers,
        },
        (upstreamRes) => {
          if ((upstreamRes.statusCode ?? 502) >= 300 && (upstreamRes.statusCode ?? 502) < 400) {
            upstreamRes.resume();
            deny(res, 502, "gateway redirects are not allowed");
            return;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      forward.on("error", () => {
        if (!res.headersSent) deny(res, 502, "gateway unreachable");
        else res.destroy();
      });
      let received = 0;
      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBody) {
          forward.destroy();
          if (!res.headersSent) deny(res, 413, "body too large");
          req.destroy();
        }
      });
      req.pipe(forward);
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    return server;
  }

  #egressServer(allowHosts: string[], allowPorts: number[], allowPrivate: boolean): http.Server {
    const server = http.createServer((req, res) => {
      deny(res, 403, "only HTTPS CONNECT tunnels are allowed");
      req.resume();
    });
    server.on("connect", async (req, clientSocket: net.Socket, head: Buffer) => {
      const target = req.url ?? "";
      const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target);
      const host = match?.[1];
      const port = Number(match?.[2]);
      if (!host || !hostAllowed(host, allowHosts) || !allowPorts.includes(port)) {
        clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      // Resolve once, check every address, then connect to the checked IP (no DNS rebinding).
      let address: string;
      try {
        const resolved = await lookup(host, { all: true, verbatim: true });
        if (
          resolved.length === 0 ||
          (!allowPrivate && resolved.some((r) => isPrivateAddress(r.address)))
        ) {
          clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        address = (resolved[0] as { address: string }).address;
      } catch {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = net.connect(port, address, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      const close = () => {
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.on("error", () => {
        if (!clientSocket.destroyed)
          clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        close();
      });
      clientSocket.on("error", close);
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    return server;
  }
}

function listen(server: http.Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      chmod(path, 0o600).then(() => resolve(), reject);
    });
  });
}
