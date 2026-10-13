import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { App } from "./route.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** Strict CSP: only same-origin scripts, styles, fonts, images and API calls; no framing. */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Paths that belong to the API and must never fall back to the SPA. */
const API_PREFIXES = ["/v1/", "/mcp", "/hooks/", "/auth/", "/healthz", "/openapi.json"];

/**
 * Serves the built dashboard same-origin (so the session cookie and CSRF token work): hashed files
 * under /assets are immutable for a year, everything else that isn't an API path falls back to
 * index.html (no-cache). Files must resolve inside the dist directory (no traversal, no symlink escape).
 */
export function dashboardRoutes(app: App, distDir: string) {
  const root = resolve(distDir);
  const security = {
    "content-security-policy": DASHBOARD_CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };

  const file = async (relative: string): Promise<{ body: Buffer; type: string } | null> => {
    const candidate = resolve(join(root, relative));
    if (candidate !== root && !candidate.startsWith(root + sep)) return null;
    try {
      const real = await realpath(candidate);
      const realRoot = await realpath(root);
      if (!real.startsWith(realRoot + sep)) return null;
      if (!(await stat(real)).isFile()) return null;
      return {
        body: await readFile(real),
        type: TYPES[extname(real)] ?? "application/octet-stream",
      };
    } catch {
      return null;
    }
  };

  app.get("*", async (c, next) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname);
    if (API_PREFIXES.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p)))
      return next();
    if (path.includes("\0")) return c.text("bad request", 400);

    if (path.startsWith("/assets/")) {
      const asset = await file(path.slice(1));
      if (!asset) return c.text("not found", 404);
      return c.body(new Uint8Array(asset.body), 200, {
        ...security,
        "content-type": asset.type,
        "cache-control": "public, max-age=31536000, immutable",
      });
    }

    const direct = path !== "/" ? await file(path.slice(1)) : null;
    if (direct && !direct.type.startsWith("text/html")) {
      return c.body(new Uint8Array(direct.body), 200, {
        ...security,
        "content-type": direct.type,
        "cache-control": "no-cache",
      });
    }
    const index = await file("index.html");
    if (!index) return c.text("dashboard not built", 503);
    return c.body(new Uint8Array(index.body), 200, {
      ...security,
      "content-type": index.type,
      "cache-control": "no-cache",
    });
  });
}
