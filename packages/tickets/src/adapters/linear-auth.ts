/**
 * Linear credentials, host-only. Two modes:
 * - personal API key (`apiKeyEnv`): sent raw in `Authorization`; actions appear as that human.
 * - OAuth app (`app`): client-credentials token, sent as `Bearer`; actions appear as the app user.
 * Secrets are read from the host env by variable NAME at use time; tokens live in memory (and an
 * optional 0600 cache file), are never logged, never included in errors, never given to sandboxes.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { FetchLike } from "./linear-client.js";

export const LINEAR_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
export const LINEAR_ENV = /^([A-Z0-9]+_)*LINEAR(_[A-Z0-9]+)*$/;

export interface LinearAppAuthConfig {
  /** Host env var NAME holding the OAuth app client id. */
  clientIdEnv: string;
  /** Host env var NAME holding the OAuth app client secret. */
  clientSecretEnv: string;
}

export interface LinearAuth {
  readonly mode: "apiKey" | "app";
  /** Value for the `Authorization` header. */
  header(): Promise<string>;
  /** Drops a token the API rejected (401); returns true when a retry may succeed. */
  invalidate(): boolean;
}

export class LinearAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearAuthError";
  }
}

export function checkEnvName(name: string, field: string): string {
  if (!ENV_NAME.test(name))
    throw new Error(`invalid ${field} ${JSON.stringify(name)}: expected an env var name`);
  return name;
}

export class ApiKeyAuth implements LinearAuth {
  readonly mode = "apiKey" as const;
  constructor(
    private readonly envName: string,
    private readonly env: () => Record<string, string | undefined>,
  ) {
    checkEnvName(envName, "apiKeyEnv");
  }
  async header(): Promise<string> {
    const key = this.env()[this.envName]?.trim();
    if (!key) throw new LinearAuthError(`Linear API key missing: set ${this.envName} on the host`);
    return key;
  }
  invalidate(): boolean {
    return false;
  }
}

export interface AppAuthOptions extends LinearAppAuthConfig {
  env: () => Record<string, string | undefined>;
  fetch: FetchLike;
  tokenEndpoint?: string;
  /** Optional 0600 file caching the token across restarts. */
  cacheFile?: string;
  now?: () => number;
  timeoutMs?: number;
}

interface Token {
  accessToken: string;
  issuedAt: number;
  expiresAt: number;
}

/** Refresh when less than this much lifetime is left (tokens last ~30 days). */
const REFRESH_MARGIN_MS = 24 * 3600_000;

export class AppAuth implements LinearAuth {
  readonly mode = "app" as const;
  #token: Token | undefined;
  #pending: Promise<Token> | undefined;
  #loadedCache = false;

  constructor(private readonly o: AppAuthOptions) {
    // Only Linear-named vars: their values are sent to Linear's token endpoint.
    for (const [name, field] of [
      [o.clientIdEnv, "app.clientIdEnv"],
      [o.clientSecretEnv, "app.clientSecretEnv"],
    ] as const)
      if (!LINEAR_ENV.test(checkEnvName(name, field)))
        throw new Error(
          `invalid ${field} ${JSON.stringify(name)}: expected an env var name containing LINEAR`,
        );
  }

  #now(): number {
    return this.o.now?.() ?? Date.now();
  }

  #fresh(t: Token | undefined): t is Token {
    if (!t) return false;
    // Short-lived tokens refresh at half-life, so a token is never "stale" on arrival.
    const margin = Math.min(REFRESH_MARGIN_MS, (t.expiresAt - t.issuedAt) / 2);
    return t.expiresAt - margin > this.#now();
  }

  async header(): Promise<string> {
    if (!this.#loadedCache) {
      this.#loadedCache = true;
      this.#token = this.#readCache();
    }
    if (!this.#fresh(this.#token)) {
      this.#pending ??= this.#fetchToken().finally(() => {
        this.#pending = undefined;
      });
      this.#token = await this.#pending;
    }
    return `Bearer ${this.#token.accessToken}`;
  }

  invalidate(): boolean {
    if (!this.#token) return false;
    this.#token = undefined;
    this.#writeCache(undefined);
    return true;
  }

  async #fetchToken(): Promise<Token> {
    const env = this.o.env();
    const id = env[this.o.clientIdEnv]?.trim();
    const secret = env[this.o.clientSecretEnv]?.trim();
    if (!id || !secret)
      throw new LinearAuthError(
        `Linear app credentials missing: set ${this.o.clientIdEnv} and ${this.o.clientSecretEnv} on the host`,
      );
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: secret,
      scope: "read,write",
    }).toString();
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.o.fetch(this.o.tokenEndpoint ?? LINEAR_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch {
      // The underlying error may echo the request: never surface it.
      throw new LinearAuthError("Linear app token request failed (network)");
    }
    let parsed: { access_token?: unknown; expires_in?: unknown } | undefined;
    try {
      parsed = JSON.parse(await res.text());
    } catch {
      parsed = undefined;
    }
    const token = parsed?.access_token;
    if (!res.ok || typeof token !== "string" || !token)
      throw new LinearAuthError(`Linear app token request failed (HTTP ${res.status})`);
    const seconds = Number(parsed?.expires_in);
    const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3600_000;
    const now = this.#now();
    const fresh = { accessToken: token, issuedAt: now, expiresAt: now + lifetime };
    this.#writeCache(fresh);
    return fresh;
  }

  /** Hash of the client id value (never the id itself, never the secret). */
  #clientTag(): string | undefined {
    const id = this.o.env()[this.o.clientIdEnv]?.trim();
    return id ? createHash("sha256").update(id).digest("hex").slice(0, 16) : undefined;
  }

  #readCache(): Token | undefined {
    if (!this.o.cacheFile) return undefined;
    try {
      const st = lstatSync(this.o.cacheFile);
      // Only trust a private regular file this process could have written.
      if (!st.isFile() || st.mode & 0o077 || st.uid !== process.getuid?.()) return undefined;
      const raw = JSON.parse(readFileSync(this.o.cacheFile, "utf8")) as Partial<Token> & {
        client?: string;
      };
      // A rotated app (different client id) never reuses the old app's token.
      if (!raw.client || raw.client !== this.#clientTag()) return undefined;
      if (
        typeof raw.accessToken !== "string" ||
        typeof raw.expiresAt !== "number" ||
        typeof raw.issuedAt !== "number"
      )
        return undefined;
      return { accessToken: raw.accessToken, issuedAt: raw.issuedAt, expiresAt: raw.expiresAt };
    } catch {
      return undefined;
    }
  }

  #writeCache(token: Token | undefined): void {
    const file = this.o.cacheFile;
    if (!file) return;
    try {
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      const data = token ? { ...token, client: this.#clientTag() } : {};
      // `wx`: never follow a planted file or symlink at the temp path.
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch {
      // The cache is an optimisation: a failed write only costs a token request next start.
    }
  }
}
