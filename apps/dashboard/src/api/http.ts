import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./generated/v1";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** Builds a path from a template, encoding every parameter. */
export function pathOf(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`missing path param ${key}`);
    return encodeURIComponent(value);
  });
}

const CSRF_COOKIE = "matrix_csrf";
let csrfToken: string | null = null;

/** Set from the session response; falls back to the double-submit cookie. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function currentCsrfToken(): string | null {
  if (csrfToken) return csrfToken;
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${CSRF_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(CSRF_COOKIE.length + 1)) : null;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function withCsrf(init: RequestInit = {}): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const token = currentCsrfToken();
  if (MUTATING.has(method) && token) headers.set("x-csrf-token", token);
  return { ...init, method, headers, credentials: "include" };
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export async function toApiError(res: Response): Promise<ApiError> {
  if (res.status === 401) for (const l of unauthorizedListeners) l();
  let code = "http_error";
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const body = (await res.clone().json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // non-JSON error body
  }
  return new ApiError(res.status, code, message);
}

const csrfMiddleware: Middleware = {
  onRequest({ request }) {
    const token = currentCsrfToken();
    if (MUTATING.has(request.method) && token) request.headers.set("x-csrf-token", token);
    return request;
  },
};

/** Typed client for the endpoints the server already exposes (PR #2 OpenAPI). */
export const v1 = createClient<paths>({
  baseUrl: API_BASE || globalThis.location?.origin,
  credentials: "include",
  // Resolve fetch per call so test interceptors and polyfills installed later are used.
  fetch: (request) => globalThis.fetch(request),
});
v1.use(csrfMiddleware);

/** Unwraps an openapi-fetch result or throws an ApiError. */
export async function unwrap<T>(
  promise: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, response } = await promise;
  if (!response.ok) throw await toApiError(response);
  return data as T;
}
