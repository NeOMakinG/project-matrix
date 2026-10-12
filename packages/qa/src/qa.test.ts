import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runApiCheck } from "./api";
import { type BrowserDriver, runScenario } from "./browser";
import { NotImplementedMobileDriver } from "./mobile";
import { PlaywrightDriver } from "./playwright";

let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "s=secret" });
      res.end(JSON.stringify({ ok: true, version: "1.2.3" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<html><body><h1 id="title">Checkout</h1><input id="email"/><button id="pay" onclick="document.getElementById('msg').innerText='Paid '+document.getElementById('email').value">Pay</button><p id="msg"></p></body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("api checks", () => {
  test("pass writes a redacted curl transcript receipt", async () => {
    const out = await mkdtemp(join(tmpdir(), "matrix-qa-"));
    const receipt = await runApiCheck(
      {
        name: "health",
        url: `${base}/api/health`,
        headers: { authorization: "Bearer topsecret" },
        expect: { status: 200, json: (v) => (v as { ok: boolean }).ok === true },
      },
      out,
    );
    expect(receipt).toMatchObject({ kind: "curl", ok: true });
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    const transcript = await readFile(receipt.path ?? "", "utf8");
    expect(transcript).toContain("PASS");
    expect(transcript).not.toContain("topsecret");
    expect(transcript).not.toContain("s=secret");
  });

  test("failures are reported, not thrown", async () => {
    const out = await mkdtemp(join(tmpdir(), "matrix-qa-"));
    const receipt = await runApiCheck(
      { name: "wrong", url: `${base}/api/health`, expect: { status: 201, bodyIncludes: ["nope"] } },
      out,
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.summary).toContain("expected 201");
    const unreachable = await runApiCheck(
      { name: "down", url: "http://127.0.0.1:9/x", expect: {} },
      out,
    );
    expect(unreachable.ok).toBe(false);
  });
});

function fakeDriver(failOn?: string): BrowserDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "fake",
    calls,
    async start() {
      calls.push("start");
    },
    async open(url) {
      calls.push(`open ${url}`);
    },
    async click(s) {
      if (s === failOn) throw new Error("not found");
      calls.push(`click ${s}`);
    },
    async fill(s, v) {
      calls.push(`fill ${s} ${v}`);
    },
    async text() {
      return "Paid a@b.c";
    },
    async waitFor() {},
    async screenshot(path) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, "png");
      calls.push("shot");
    },
    async stop() {
      calls.push("stop");
      return undefined;
    },
  };
}

describe("scenario runner", () => {
  const scenario = {
    name: "Checkout happy path",
    steps: [
      { do: "open" as const, url: "http://x" },
      { do: "fill" as const, selector: "#email", value: "a@b.c" },
      { do: "click" as const, selector: "#pay" },
      { do: "expectText" as const, selector: "#msg", includes: "Paid" },
      { do: "screenshot" as const, name: "paid" },
    ],
  };

  test("collects screenshot receipts and always stops the driver", async () => {
    const driver = fakeDriver();
    const result = await runScenario(driver, scenario, await mkdtemp(join(tmpdir(), "matrix-sc-")));
    expect(result.ok).toBe(true);
    expect(result.receipts.map((r) => r.kind)).toEqual(["screenshot"]);
    expect(driver.calls.at(-1)).toBe("stop");
  });

  test("a failing step captures a failure screenshot", async () => {
    const driver = fakeDriver("#pay");
    const result = await runScenario(driver, scenario, await mkdtemp(join(tmpdir(), "matrix-sc-")));
    expect(result).toMatchObject({ ok: false, failedStep: 2 });
    expect(result.receipts[0]).toMatchObject({ kind: "screenshot", ok: false });
    expect(driver.calls.at(-1)).toBe("stop");
  });
});

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
describe.runIf(existsSync(chrome))("playwright driver (real Chrome)", () => {
  test("runs a scenario with screenshot and video receipts", async () => {
    const out = await mkdtemp(join(tmpdir(), "matrix-pw-"));
    const result = await runScenario(
      new PlaywrightDriver({ executablePath: chrome }),
      {
        name: "checkout",
        steps: [
          { do: "open", url: base },
          { do: "fill", selector: "#email", value: "qa@matrix.dev" },
          { do: "click", selector: "#pay" },
          { do: "expectText", selector: "#msg", includes: "Paid qa@matrix.dev" },
          { do: "screenshot", name: "paid" },
        ],
      },
      out,
    );
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.receipts.map((r) => r.kind)).toEqual(["screenshot", "video"]);
    expect(result.receipts.every((r) => r.sha256 && r.path && existsSync(r.path))).toBe(true);
  }, 60_000);
});

test("mobile drivers are explicit stubs", async () => {
  await expect(new NotImplementedMobileDriver("agent-device", "android").launch()).rejects.toThrow(
    /not implemented/,
  );
});
