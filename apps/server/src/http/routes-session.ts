import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type Guard, HttpError } from "../auth/guard.js";
import { type KeyStore, toPublic } from "../auth/keys.js";
import { RateLimiter } from "../auth/limits.js";
import {
  csrfMatches,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type Session,
  type SessionStore,
} from "../auth/sessions.js";
import type { App, AppEnv } from "./route.js";

export interface SessionOptions {
  /** Origins allowed to send cookie-authenticated requests (e.g. the dashboard URL). */
  allowedOrigins?: string[];
  /** Set false only for plain-http local development. */
  secureCookies?: boolean;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function cookieOptions(options: SessionOptions) {
  return {
    httpOnly: true,
    secure: options.secureCookies ?? true,
    sameSite: "Strict" as const,
    path: "/",
  };
}

/** Rejects cross-site requests: when the browser sends an Origin, it must be an allowed one. */
function checkOrigin(c: Context<AppEnv>, options: SessionOptions) {
  const origin = c.req.header("origin");
  if (!origin) return;
  const self = new URL(c.req.url).origin;
  if (origin !== self && !(options.allowedOrigins ?? []).includes(origin)) {
    throw new HttpError(403, "bad_origin", "origin not allowed");
  }
}

/**
 * Authenticates `/v1/*`: a Bearer API key wins; otherwise the dashboard session cookie. Cookie
 * requests that change state must send the session's CSRF token in `x-csrf-token` and come from an
 * allowed origin. Reads (including the SSE stream) only need the cookie.
 */
export function authMiddleware(
  guard: Guard,
  keys: KeyStore,
  sessions: SessionStore,
  options: SessionOptions,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const idempotencyKey = c.req.header("idempotency-key");
    const authorization = c.req.header("authorization");
    if (authorization) {
      c.set("principal", guard.authenticate(authorization, idempotencyKey));
      return next();
    }
    const session = sessions.get(getCookie(c, SESSION_COOKIE));
    const key = session ? keys.get(session.keyId) : null;
    if (!session || !key || key.revokedAt) {
      throw new HttpError(401, "unauthorized", "missing or invalid API key or session");
    }
    if (!SAFE_METHODS.has(c.req.method)) {
      checkOrigin(c, options);
      if (!csrfMatches(session, c.req.header("x-csrf-token"))) {
        throw new HttpError(403, "csrf", "missing or invalid CSRF token");
      }
    }
    c.set("principal", guard.principalFor(key, idempotencyKey));
    return next();
  };
}

function sessionBody(session: Session, keys: KeyStore) {
  const key = keys.get(session.keyId);
  return {
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
    key: key ? toPublic(key) : null,
  };
}

/** Dashboard login with a human API key; the cookie carries a random session id, never the key. */
export function sessionRoutes(
  app: App,
  keys: KeyStore,
  sessions: SessionStore,
  options: SessionOptions,
) {
  // Failed logins are rate limited globally to slow down key guessing.
  const failures = new RateLimiter();
  keys.onRevoke((id) => sessions.deleteForKey(id));

  app.post("/auth/login", async (c) => {
    checkOrigin(c, options);
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof body?.token === "string" ? body.token : "";
    const key = keys.verify(token);
    if (!key) {
      const slot = failures.take("login", 20);
      if (!slot.ok)
        throw new HttpError(429, "rate_limited", "too many failed logins", slot.retryAfterSec);
      throw new HttpError(401, "unauthorized", "invalid API key");
    }
    if (key.kind !== "human") {
      throw new HttpError(403, "forbidden", "only human keys can open a dashboard session");
    }
    const previous = getCookie(c, SESSION_COOKIE);
    if (previous) sessions.delete(previous);
    const session = sessions.create(key.id);
    setCookie(c, SESSION_COOKIE, session.id, {
      ...cookieOptions(options),
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.json(sessionBody(session, keys));
  });

  app.get("/auth/session", (c) => {
    const session = sessions.get(getCookie(c, SESSION_COOKIE));
    if (!session) throw new HttpError(401, "unauthorized", "no session");
    return c.json(sessionBody(session, keys));
  });

  app.post("/auth/logout", (c) => {
    const session = sessions.get(getCookie(c, SESSION_COOKIE));
    if (session) {
      checkOrigin(c, options);
      if (!csrfMatches(session, c.req.header("x-csrf-token"))) {
        throw new HttpError(403, "csrf", "missing or invalid CSRF token");
      }
      sessions.delete(session.id);
    }
    deleteCookie(c, SESSION_COOKIE, cookieOptions(options));
    return c.json({ ok: true });
  });
}
