import { describe, expect, test } from "vitest";
import { environmentFailure } from "./environment.js";
import { createHarness } from "./testing/index.js";

describe("environmentFailure", () => {
  test("missing binaries and dependencies are environmental", () => {
    expect(environmentFailure(127, "", 5000)).toContain("exit 127");
    expect(environmentFailure(1, "sh: 1: tsc: not found", 5000)).toContain("not found");
    expect(environmentFailure(1, "> x\nbash: line 1: vitest: command not found", 5000)).toContain(
      "not found",
    );
    expect(environmentFailure(1, "Error: spawn vitest ENOENT", 5000)).toContain("ENOENT");
    expect(
      environmentFailure(1, "Error: Cannot find module '/work/app/node_modules/.bin/tsc'", 9000),
    ).toContain("node_modules");
  });

  test("genuine code failures are not", () => {
    expect(environmentFailure(0, "sh: tsc: command not found", 10)).toBeUndefined();
    expect(environmentFailure(1, "expected 'user: not found' to equal 'ok'", 3000)).toBeUndefined();
    expect(environmentFailure(1, "FAIL src/a.test.ts expected 1 to be 2", 400)).toBeUndefined();
    expect(environmentFailure(1, "Error: Cannot find module './missing'", 3000)).toBeUndefined();
    expect(environmentFailure(2, "ENOENT reading fixture", 300)).toBeUndefined();
    expect(
      environmentFailure(1, "Cannot find module '/work/node_modules/pkg/deep/path.js'", 3000),
    ).toBeUndefined();
  });
});

async function runUntilIdle(harness: ReturnType<typeof createHarness>) {
  for (let index = 0; index < 4; index++) {
    await harness.reconciler.tick();
    await harness.reconciler.idle();
  }
}

describe("checks phase", () => {
  test("an environment failure blocks for a human without bouncing to implement", async () => {
    const harness = createHarness({ project: { maxAttempts: 5, maxLoops: 5 } });
    harness.deps.sandbox = {
      kind: "bwrap",
      exec: async () => ({ code: 127, stdout: "", stderr: "sh: 1: tsc: not found" }),
    };
    try {
      await harness.setup();
      const ticket = harness.tickets.add("deps missing");
      await runUntilIdle(harness);
      const workflow = await harness.store.getWorkflow(harness.project.id, ticket.id);
      expect(workflow).toMatchObject({ phase: "checks", status: "blocked", loops: 0, attempt: 0 });
      expect(workflow?.lastError).toContain("environment:");
      const runs = await harness.store.listRuns({ ticketId: ticket.id });
      expect(runs.map((run) => run.phase)).toEqual(["spike", "implement", "checks"]);
    } finally {
      harness.reconciler.stop();
      await harness.reconciler.idle();
    }
  });

  test("setup runs before checks; a failed setup blocks without running checks", async () => {
    const harness = createHarness({ project: { maxAttempts: 5, maxLoops: 5 } });
    const order: string[] = [];
    harness.deps.setup = async (ctx) => {
      order.push(`setup ${ctx.workdir}`);
      return {
        ok: false,
        summary: "npm ci exit 1",
        receipts: [{ kind: "log", ok: false, summary: "setup app: npm ci exit 1" }],
      };
    };
    const exec = harness.deps.sandbox!.exec.bind(harness.deps.sandbox);
    harness.deps.sandbox = {
      kind: "bwrap",
      exec: async (spec) => {
        order.push(`check ${spec.cmd.join(" ")}`);
        return exec(spec);
      },
    };
    try {
      await harness.setup();
      const ticket = harness.tickets.add("setup fails");
      await runUntilIdle(harness);
      const workflow = await harness.store.getWorkflow(harness.project.id, ticket.id);
      expect(workflow).toMatchObject({ phase: "checks", status: "blocked", attempt: 0, loops: 0 });
      expect(workflow?.lastError).toContain("dependency setup failed: npm ci exit 1");
      // Once before implement (best effort, failure ignored), once before checks; no check ran.
      expect(order).toHaveLength(2);
      expect(order.every((entry) => entry.startsWith("setup "))).toBe(true);
    } finally {
      harness.reconciler.stop();
      await harness.reconciler.idle();
    }
  });
});
