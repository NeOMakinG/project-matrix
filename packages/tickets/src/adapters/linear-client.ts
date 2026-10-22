/**
 * Minimal fetch-based client for Linear's GraphQL API. Host-only: the API key is read from the
 * host environment by variable NAME at request time and is never stored on the instance, logged or
 * included in errors.
 */

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface LinearClientOptions {
  /** Name of the host env var holding the personal API key. Default `LINEAR_API_KEY`. */
  apiKeyEnv?: string;
  /** Environment to read the key from. Default `process.env`. */
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  endpoint?: string;
  signal?: AbortSignal;
  /** Retries on 429 / 5xx / network errors. Default 4. */
  maxRetries?: number;
  /** Per-request timeout. Default 15s. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}

interface GraphQLError {
  message?: string;
  extensions?: { code?: string; type?: string; userPresentableMessage?: string };
}

const MAX_BACKOFF_MS = 30_000;

/** Keeps error text short and free of anything that looks like a Linear key. */
function scrub(text: string): string {
  return text.replace(/lin_(?:api|oauth)_[A-Za-z0-9]+/g, "lin_***").slice(0, 400);
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class LinearClient {
  readonly #o: LinearClientOptions;

  constructor(options: LinearClientOptions = {}) {
    const envName = options.apiKeyEnv ?? "LINEAR_API_KEY";
    if (!/^[A-Z_][A-Z0-9_]*$/.test(envName))
      throw new Error(`invalid apiKeyEnv ${JSON.stringify(envName)}: expected an env var name`);
    this.#o = { ...options, apiKeyEnv: envName };
  }

  #key(): string {
    const env = this.#o.env ?? process.env;
    const key = env[this.#o.apiKeyEnv as string]?.trim();
    if (!key)
      throw new LinearApiError(`Linear API key missing: set ${this.#o.apiKeyEnv} on the host`);
    return key;
  }

  #backoff(attempt: number, retryAfter: string | null, reset: string | null): number {
    const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    const resetMs = reset ? Number(reset) : Number.NaN;
    if (Number.isFinite(resetMs) && resetMs > Date.now())
      return Math.min(resetMs - Date.now(), MAX_BACKOFF_MS);
    return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
  }

  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const doFetch = this.#o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const sleep = this.#o.sleep ?? ((ms: number) => defaultSleep(ms, this.#o.signal));
    const maxRetries = this.#o.maxRetries ?? 4;
    const body = JSON.stringify({ query, variables });
    // A mutation that timed out or hit a 5xx may have been applied: only retry it on rate limits,
    // which Linear rejects before executing. Queries are safe to retry on any transient failure.
    const idempotent = !/^\s*mutation\b/m.test(query);
    for (let attempt = 0; ; attempt++) {
      this.#o.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(this.#o.timeoutMs ?? 15_000);
      const signal = this.#o.signal ? AbortSignal.any([this.#o.signal, timeout]) : timeout;
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await doFetch(this.#o.endpoint ?? LINEAR_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: this.#key() },
          body,
          signal,
        });
      } catch (error) {
        if (error instanceof LinearApiError || this.#o.signal?.aborted) throw error;
        if (attempt >= maxRetries || !idempotent)
          throw new LinearApiError(`Linear request failed: ${scrub(String(error))}`);
        await sleep(this.#backoff(attempt, null, null));
        continue;
      }
      const text = await response.text();
      let parsed: { data?: T; errors?: GraphQLError[] } | undefined;
      try {
        parsed = text ? (JSON.parse(text) as typeof parsed) : undefined;
      } catch {
        parsed = undefined;
      }
      const rateLimited =
        response.status === 429 ||
        parsed?.errors?.some((e) => e.extensions?.code === "RATELIMITED") === true;
      if ((rateLimited || (idempotent && response.status >= 500)) && attempt < maxRetries) {
        await sleep(
          this.#backoff(
            attempt,
            response.headers.get("retry-after"),
            response.headers.get("x-ratelimit-requests-reset"),
          ),
        );
        continue;
      }
      if (parsed?.errors?.length) {
        const first = parsed.errors[0];
        const message = first?.extensions?.userPresentableMessage ?? first?.message ?? "unknown";
        throw new LinearApiError(
          `Linear GraphQL error: ${scrub(message)}`,
          response.status,
          first?.extensions?.code,
        );
      }
      if (!response.ok)
        throw new LinearApiError(
          `Linear HTTP ${response.status}: ${scrub(text)}`,
          response.status,
          rateLimited ? "RATELIMITED" : undefined,
        );
      if (!parsed?.data) throw new LinearApiError("Linear response had no data", response.status);
      return parsed.data;
    }
  }
}

/**
 * Issue titles, bodies, labels and comments are untrusted (anyone with workspace access writes
 * them, and they flow into agent prompts). Strip invisible characters that can hide instructions:
 * zero-width, bidi overrides/isolates, tag characters, variation-selector supplement, soft hyphen,
 * fillers and C0/C1 controls other than tab/newline/CR.
 */
const HIDDEN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

export function sanitizeUntrusted(text: string): string {
  return text.normalize("NFC").replace(HIDDEN, "");
}
