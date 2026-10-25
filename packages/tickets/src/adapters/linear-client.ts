/**
 * Minimal fetch-based client for Linear's GraphQL API. Host-only: credentials are read from the
 * host environment by variable NAME (see `linear-auth.ts`) and are never logged or included in
 * errors. App mode (OAuth client credentials) wins over a personal key when both are configured.
 */
import { ApiKeyAuth, AppAuth, type LinearAppAuthConfig, type LinearAuth } from "./linear-auth.js";

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

export type UploadFetch = (
  url: string,
  init: { method: "PUT"; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

const FILE_UPLOAD = `mutation MatrixFileUpload($contentType: String!, $filename: String!, $size: Int!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size) {
    success
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}`;

export interface LinearClientOptions {
  /** Name of the host env var holding the personal API key. Default `LINEAR_API_KEY`. */
  apiKeyEnv?: string;
  /** OAuth app (client credentials): Matrix acts as its own Linear user. Preferred when set. */
  app?: LinearAppAuthConfig;
  /** Optional 0600 file caching the app token across restarts (app mode only). */
  tokenCacheFile?: string;
  /** Token endpoint override (tests). */
  tokenEndpoint?: string;
  /** Clock for token expiry (tests). */
  now?: () => number;
  /** Environment to read the key from. Default `process.env`. */
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  /** Binary PUT for file uploads (tests). Default `globalThis.fetch`. */
  uploadFetch?: UploadFetch;
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
  readonly #auth: LinearAuth;

  constructor(options: LinearClientOptions = {}) {
    this.#o = options;
    const env = () => options.env ?? process.env;
    const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#auth = options.app
      ? new AppAuth({
          ...options.app,
          env,
          fetch: doFetch,
          ...(options.tokenEndpoint ? { tokenEndpoint: options.tokenEndpoint } : {}),
          ...(options.tokenCacheFile ? { cacheFile: options.tokenCacheFile } : {}),
          ...(options.now ? { now: options.now } : {}),
        })
      : new ApiKeyAuth(options.apiKeyEnv ?? "LINEAR_API_KEY", env);
  }

  /** `app` when Matrix acts as its own Linear app user, `apiKey` for a personal key. */
  get authMode(): "apiKey" | "app" {
    return this.#auth.mode;
  }

  async #key(): Promise<string> {
    try {
      return await this.#auth.header();
    } catch (error) {
      throw new LinearApiError(scrub((error as Error).message));
    }
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
    let reauthed = false;
    for (let attempt = 0; ; attempt++) {
      this.#o.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(this.#o.timeoutMs ?? 15_000);
      const signal = this.#o.signal ? AbortSignal.any([this.#o.signal, timeout]) : timeout;
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await doFetch(this.#o.endpoint ?? LINEAR_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: await this.#key() },
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
      // An expired or revoked app token: Linear rejects before executing, so even a mutation
      // is safe to resend once with a fresh token.
      const unauthenticated =
        response.status === 401 ||
        parsed?.errors?.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR") === true;
      if (unauthenticated && !reauthed && this.#auth.invalidate()) {
        reauthed = true;
        continue;
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

  /** Uploads a file to Linear storage (signed PUT) and returns its https asset URL. */
  async upload(filename: string, contentType: string, bytes: Uint8Array): Promise<string> {
    const data = await this.request<{
      fileUpload: {
        success: boolean;
        uploadFile: {
          uploadUrl: string;
          assetUrl: string;
          headers: { key: string; value: string }[];
        } | null;
      };
    }>(FILE_UPLOAD, { contentType, filename, size: bytes.byteLength });
    const file = data.fileUpload.uploadFile;
    if (!data.fileUpload.success || !file) throw new Error("Linear fileUpload failed");
    if (!/^https:\/\//.test(file.uploadUrl) || !/^https:\/\/[^\s()<>]+$/.test(file.assetUrl))
      throw new Error("Linear fileUpload returned a non-https URL");
    // The asset URL is embedded in a comment: only Linear's own upload host, never a
    // look-alike (`uploads.linear.app.evil`, `user@host`, an explicit port).
    if (!isLinearAssetUrl(file.assetUrl))
      throw new Error("Linear fileUpload returned an asset URL outside Linear's upload host");
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000",
    };
    for (const h of file.headers) headers[h.key] = h.value;
    const put = this.#o.uploadFetch ?? (globalThis.fetch as unknown as UploadFetch);
    const res = await put(file.uploadUrl, {
      method: "PUT",
      headers,
      body: bytes,
      signal: AbortSignal.timeout(this.#o.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`Linear file upload PUT failed with HTTP ${res.status}`);
    return file.assetUrl;
  }
}

/** Linear serves uploaded files from this host only. */
export const LINEAR_UPLOAD_HOST = "uploads.linear.app";

/** True for a plain `https://uploads.linear.app/...` URL (no credentials, port or look-alike). */
export function isLinearAssetUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === LINEAR_UPLOAD_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    value.startsWith(`https://${LINEAR_UPLOAD_HOST}/`)
  );
}

/**
 * The evidence the QA lane uploads, nothing else: screenshots and plain-text logs. Extension,
 * declared type and (for images) the file signature must agree; each type has a size cap.
 */
const EVIDENCE_TYPES: Record<
  string,
  { ext: string[]; maxBytes: number; magic?: (b: Uint8Array) => boolean }
> = {
  "image/png": {
    ext: ["png"],
    maxBytes: 10 * 1024 * 1024,
    magic: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  "image/jpeg": {
    ext: ["jpg", "jpeg"],
    maxBytes: 10 * 1024 * 1024,
    magic: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  },
  "image/webp": {
    ext: ["webp"],
    maxBytes: 10 * 1024 * 1024,
    magic: (b) =>
      startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  },
  "text/plain": { ext: ["txt", "log"], maxBytes: 1024 * 1024 },
};

const startsWith = (bytes: Uint8Array, prefix: number[]) =>
  bytes.byteLength >= prefix.length && prefix.every((v, i) => bytes[i] === v);

/** Throws unless `name`/`contentType`/`bytes` is an allowed QA evidence file within its cap. */
export function checkEvidenceUpload(name: string, contentType: string, bytes: Uint8Array): void {
  const type = EVIDENCE_TYPES[contentType.trim().toLowerCase()];
  if (!type) throw new Error(`upload type ${JSON.stringify(contentType)} is not allowed`);
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (!name.includes(".") || !type.ext.includes(ext))
    throw new Error(`upload name does not match ${contentType}`);
  if (bytes.byteLength === 0) throw new Error("upload is empty");
  if (bytes.byteLength > type.maxBytes)
    throw new Error(`upload larger than ${type.maxBytes / (1024 * 1024)} MB for ${contentType}`);
  if (type.magic && !type.magic(bytes)) throw new Error(`upload content is not ${contentType}`);
}

export { sanitizeUntrusted } from "../sanitize.js";
