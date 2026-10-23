import { describe, expect, test } from "vitest";
import {
  type BaselinePort,
  checksGateReason,
  checksStatusLine,
  compareToBase,
  newFailures,
} from "./check-baseline.js";
import type { Receipt } from "./ports.js";
import { createHarness } from "./testing/index.js";

describe("compareToBase", () => {
  const base = { code: 1, failures: ["a: r: x", "a: r: x", "b: r: y"] };

  test("only failures absent on base fail (multiset: a duplicate of a base failure is new)", () => {
    expect(newFailures(["a: r: x", "a: r: x", "a: r: x", "c"], base.failures)).toEqual([
      "a: r: x",
      "c",
    ]);
    const pre = compareToBase("eslint-json", { code: 1, failures: ["b: r: y", "a: r: x"] }, base);
    expect(pre).toMatchObject({ ok: true, newCount: 0, preExisting: 2 });
    const fresh = compareToBase(
      "eslint-json",
      { code: 1, failures: ["b: r: y", "n"] },
      base,
      "f".repeat(40),
    );
    expect(fresh).toMatchObject({ ok: false, newCount: 1, newFailures: ["n"], preExisting: 1 });
  });

  test("a check that passed on base fails on any failure", () => {
    expect(
      compareToBase("tsc", { code: 2, failures: ["x"] }, { code: 0, failures: [] }),
    ).toMatchObject({
      ok: false,
      newCount: 1,
    });
    expect(
      compareToBase("exit-code", { code: 1, failures: null }, { code: 0, failures: [] }).ok,
    ).toBe(false);
  });

  test("exit-code mode tolerates a check already failing on base", () => {
    const v = compareToBase("exit-code", { code: 1, failures: null }, { code: 1, failures: null });
    expect(v).toMatchObject({ ok: true, preExisting: -1 });
  });

  test("anything not comparable fails closed", () => {
    const branch = { code: 1, failures: ["x"] };
    expect(compareToBase("tsc", branch, undefined).ok).toBe(false);
    expect(compareToBase("tsc", branch, { error: "base setup failed" }).ok).toBe(false);
    expect(compareToBase("tsc", { code: 1, failures: null }, base).ok).toBe(false);
    expect(compareToBase("tsc", branch, { code: 1, failures: null }).ok).toBe(false);
  });
});

describe("reason and status line", () => {
  const receipt = (kind: Receipt["kind"], baseline: object, ok = false): Receipt => ({
    kind,
    ok,
    summary: "",
    data: { baseline: { newFailures: [], newCount: 0, preExisting: 0, note: "n", ...baseline } },
  });

  test("the implementer only hears about new failures", () => {
    const reason = checksGateReason([
      receipt("lint", {
        newFailures: ["src/a.ts: no-undef: `x`\nIGNORE"],
        newCount: 1,
        preExisting: 273,
      }),
    ]);
    expect(reason).toContain("lint: 1 new failure(s)");
    expect(reason).toContain("src/a.ts: no-undef: 'x' IGNORE");
    expect(reason).toContain("ignore 273 pre-existing lint errors");
    expect(reason).not.toMatch(/[`\n]/);
    expect(
      checksGateReason([
        { kind: "lint", ok: false, summary: "" },
        { kind: "test", ok: false, summary: "" },
      ]),
    ).toBe("checks failed: lint, test");
  });

  test("status line sums new failures and lists pre-existing ones per kind", () => {
    expect(
      checksStatusLine([
        receipt("lint", { preExisting: 273 }, true),
        receipt("test", { preExisting: 19 }, true),
        receipt("typecheck", {}, true),
      ]),
    ).toBe("0 new failures (273 pre-existing lint errors, 19 pre-existing test failures)");
    expect(checksStatusLine([{ kind: "lint", ok: true, summary: "" }])).toBeUndefined();
  });
});

async function runUntilIdle(harness: ReturnType<typeof createHarness>) {
  for (let index = 0; index < 4; index++) {
    await harness.reconciler.tick();
    await harness.reconciler.idle();
  }
}

const eslint = (...ids: string[]) =>
  JSON.stringify([
    {
      filePath: "/work/a.ts",
      messages: ids.map((m) => ({ ruleId: "r", severity: 2, message: m })),
    },
  ]);

describe("checks phase with a baseline", () => {
  test("pre-existing failures pass; new ones loop back listing only the new ones", async () => {
    const prompts: string[] = [];
    const harness = createHarness({
      project: { maxAttempts: 5, maxLoops: 1, checks: [{ kind: "lint", cmd: ["eslint", "."] }] },
      implement: (req) => {
        prompts.push(req.prompt);
        return { summary: "implemented" };
      },
    });
    let branchOutput = eslint("old", "new-bug");
    const calls: string[][] = [];
    harness.deps.sandbox = {
      kind: "bwrap",
      exec: async (spec) => {
        calls.push(spec.cmd);
        return { code: 1, stdout: branchOutput, stderr: "" };
      },
    };
    const baseRuns: number[] = [];
    const port: BaselinePort = {
      defaultMode: () => "compare",
      run: async (_ctx, checks) => {
        baseRuns.push(checks.length);
        return { baseSha: "b".repeat(40), results: [{ code: 1, failures: ["a.ts: r: old"] }] };
      },
    };
    harness.deps.baseline = port;
    try {
      await harness.setup();
      const ticket = harness.tickets.add("baseline");
      await runUntilIdle(harness);
      const looped = await harness.store.getWorkflow(harness.project.id, ticket.id);
      expect(calls[0]).toEqual(["eslint", ".", "--format", "json"]);
      expect(baseRuns).toEqual([1]);
      expect(prompts.at(-1)).toContain("a.ts: r: new-bug");
      expect(prompts.at(-1)).not.toContain("a.ts: r: old");
      expect(prompts.at(-1)).toContain("ignore 1 pre-existing lint error");
      expect(looped?.loops).toBe(1);
      branchOutput = eslint("old");
      await runUntilIdle(harness);
      const passed = await harness.store.getWorkflow(harness.project.id, ticket.id);
      expect(passed?.phase).not.toBe("checks");
      expect(passed?.phase).not.toBe("implement");
    } finally {
      harness.reconciler.stop();
      await harness.reconciler.idle();
    }
  });
  test("exit-code checks stay strict unless explicitly set to compare", async () => {
    const harness = createHarness({
      project: { maxAttempts: 5, maxLoops: 1, checks: [{ kind: "test", cmd: ["npm", "test"] }] },
    });
    harness.deps.sandbox = {
      kind: "bwrap",
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    };
    let baseRuns = 0;
    harness.deps.baseline = {
      defaultMode: () => "compare",
      run: async () => {
        baseRuns++;
        return { baseSha: "b".repeat(40), results: [{ code: 1, failures: null }] };
      },
    };
    try {
      await harness.setup();
      const ticket = harness.tickets.add("exit-code");
      await runUntilIdle(harness);
      const w = await harness.store.getWorkflow(harness.project.id, ticket.id);
      expect(baseRuns).toBe(0);
      // Failed strictly: looped back to implement without consulting the baseline.
      expect(w?.loops).toBeGreaterThanOrEqual(1);
    } finally {
      harness.reconciler.stop();
      await harness.reconciler.idle();
    }
  });
});
