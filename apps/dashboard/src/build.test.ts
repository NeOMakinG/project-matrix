// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const outDir = mkdtempSync(join(tmpdir(), "matrix-dashboard-build-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("production build", () => {
  it("never bundles or starts MSW", async () => {
    const { build } = await import("vite");
    await build({
      root: resolve(__dirname, ".."),
      configFile: resolve(__dirname, "../vite.config.ts"),
      logLevel: "silent",
      mode: "production",
      build: { outDir, emptyOutDir: true },
    });
    const output = files(outDir);
    expect(output.some((f) => f.endsWith("mockServiceWorker.js"))).toBe(false);
    const code = output
      .filter((f) => /\.(js|html)$/.test(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const marker of [
      "setupWorker",
      "mockServiceWorker",
      "msw/browser",
      "MOCK_SERVICE_WORKER",
      "csrf-test-token",
    ]) {
      expect(code.includes(marker), marker).toBe(false);
    }
  }, 120_000);

  it("builds a static bundle the server can mount under a prefix", async () => {
    const { build } = await import("vite");
    const prefixed = mkdtempSync(join(tmpdir(), "matrix-dashboard-prefixed-"));
    process.env.VITE_BASE = "/dashboard/";
    try {
      await build({
        root: resolve(__dirname, ".."),
        configFile: resolve(__dirname, "../vite.config.ts"),
        logLevel: "silent",
        mode: "production",
        build: { outDir: prefixed, emptyOutDir: true },
      });
      const html = readFileSync(join(prefixed, "index.html"), "utf8");
      expect(html).toMatch(/src="\/dashboard\/assets\/index-[\w-]+\.js"/);
      expect(html).not.toMatch(/src="\/assets\//);
    } finally {
      delete process.env.VITE_BASE;
      rmSync(prefixed, { recursive: true, force: true });
    }
  }, 120_000);
});
