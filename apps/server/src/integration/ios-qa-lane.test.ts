import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentQaRequest, ProjectConfig } from "@matrix/core";
import type { CommandRunner } from "@matrix/qa";
import { beforeAll, expect, test } from "vitest";
import { iosLaneSchema, TapflowIosQaLane } from "./ios-qa-lane.js";

const SHA = "c".repeat(40);
const UDID = "241CA4C0-C8CE-4904-A61B-67E81E09B621";
const config = iosLaneSchema.parse({
  host: "mini@100.105.165.15",
  udid: UDID,
  projects: {
    tj: {
      repo: "NeOMakinG/wayline",
      build: "cd app && npm ci",
      app: "app/ios/build/Build/Products/Release-iphonesimulator/*.app",
      appId: "com.wayline.app",
    },
  },
});
const REPORT = JSON.stringify({
  verdict: "PASS",
  summary: "ok",
  steps: [{ action: "a", expected: "b", actual: "b", ok: true, criterion: 1 }],
});

beforeAll(() => {
  process.env.MATRIX_QA_LOCAL_ROOT = mkdtempSync(join(tmpdir(), "mx-ios-test-"));
});

function request(): AgentQaRequest {
  return {
    project: { id: "tj" } as ProjectConfig,
    ticket: { id: "NEO-8", title: "t", body: "b", comments: [] },
    pullRequest: { url: "u", number: 3512, repo: "NeOMakinG/wayline" },
    headSha: SHA,
    surfaces: ["ios"],
    criteria: ["opens"],
    signal: new AbortController().signal,
  };
}

function fake(opts: { fail?: Record<string, number>; slowAgentMs?: number } = {}) {
  const steps: string[][] = [];
  const remote: CommandRunner = {
    run: async (argv) => {
      const step = argv.slice(3);
      steps.push(step);
      const code = opts.fail?.[step[0] ?? ""];
      if (code) return { exitCode: code, stdout: Buffer.alloc(0), stderr: "held by someone" };
      const out = step[0] === "precheck" ? "model=iPhone 17 Pro\nos=iOS 26.3\n" : "";
      return { exitCode: 0, stdout: Buffer.from(out), stderr: "" };
    },
  };
  const local: CommandRunner = {
    run: async (argv) => {
      if (opts.slowAgentMs) await new Promise((r) => setTimeout(r, opts.slowAgentMs));
      writeFileSync(join(argv[2] ?? "", "out", "report.json"), REPORT);
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    },
  };
  return { steps, remote, local };
}

test("locks the configured simulator by UDID, beats while holding it, unlocks after cleanup", async () => {
  const f = fake({ slowAgentMs: 60 });
  const lane = new TapflowIosQaLane(config, {
    remote: f.remote,
    local: f.local,
    holder: "matrix-server@bosgame-ios",
    beatMs: 10,
  });
  const out = await lane.run(request());
  expect(out.kind).toBe("report");
  const lock = f.steps.find((s) => s[0] === "lock");
  expect(lock).toEqual([
    "lock",
    expect.stringMatching(/^mx-/),
    "1200",
    "matrix-server@bosgame-ios",
    UDID,
  ]);
  const names = f.steps.map((s) => s[0]);
  expect(names).toContain("beat");
  expect(names.slice(-2)).toEqual(["cleanup", "unlock"]);
  // No beat after the lock is released.
  const beatsAfter = f.steps.length;
  await new Promise((r) => setTimeout(r, 40));
  expect(f.steps.length).toBe(beatsAfter);
});

test("a busy simulator (exit 12) is BLOCKED with the tenant reason and never unlocked", async () => {
  const f = fake({ fail: { lock: 12 } });
  const lane = new TapflowIosQaLane(config, { remote: f.remote, local: f.local });
  const out = await lane.run(request());
  expect(out).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/simulator busy/) });
  expect(f.steps.map((s) => s[0])).not.toContain("unlock");
});

test("a restarted server reclaims its own lock before the first job", async () => {
  const f = fake();
  const lane = new TapflowIosQaLane(config, {
    remote: f.remote,
    local: f.local,
    holder: "matrix-server@bosgame-ios",
    reclaimOnStart: true,
  });
  await lane.run(request());
  expect(f.steps[0]).toEqual(["reclaim", "matrix-server@bosgame-ios"]);
  expect(f.steps[1]?.[0]).toBe("precheck");
});
