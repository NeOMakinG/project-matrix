import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MemoryCore } from "../memory-core.js";
import { createServer } from "./app.js";
import { DASHBOARD_CSP } from "./dashboard-static.js";

function dist() {
  const dir = mkdtempSync(join(tmpdir(), "matrix-dash-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><script type="module" src="/assets/app-abc123.js"></script>',
  );
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log('app')");
  writeFileSync(join(dir, "favicon.svg"), "<svg/>");
  const outside = mkdtempSync(join(tmpdir(), "matrix-secret-"));
  writeFileSync(join(outside, "secret.txt"), "top secret");
  symlinkSync(join(outside, "secret.txt"), join(dir, "assets", "leak.js"));
  return dir;
}

describe("dashboard served same-origin", () => {
  const { app } = createServer({ core: new MemoryCore(), dashboardDir: dist() });

  test("index and SPA routes get the HTML with a strict CSP and no caching", async () => {
    for (const path of ["/", "/projects/abc/board", "/runs/r1"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-security-policy")).toBe(DASHBOARD_CSP);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  test("hashed assets are immutable", async () => {
    const response = await app.request("/assets/app-abc123.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toContain("javascript");
  });

  test("traversal and symlink escapes are refused", async () => {
    expect((await app.request("/assets/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await app.request("/assets/leak.js")).status).toBe(404);
    expect((await app.request("/assets/missing.js")).status).toBe(404);
  });

  test("API paths are never swallowed by the SPA fallback", async () => {
    expect((await app.request("/v1/projects")).status).toBe(401);
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/openapi.json")).headers.get("content-type")).toContain("json");
  });

  test("other static files are served from the dist root", async () => {
    const response = await app.request("/favicon.svg");
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
  });
});
