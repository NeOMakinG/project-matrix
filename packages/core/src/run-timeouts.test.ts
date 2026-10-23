import { describe, expect, test } from "vitest";
import { implementTestingGuidance } from "./handlers.js";
import { phaseTimeoutMs } from "./models.js";
import { runTimeoutSummary } from "./reconcile.js";
import { testProject } from "./testing/fakes.js";
import { createHarness } from "./testing/harness.js";

const at = (iso: string) => new Date(`2026-10-23T${iso}Z`);

describe("per-phase run timeouts", () => {
  test("a phase override wins, other phases keep runTimeoutMs", () => {
    const project = testProject({ runTimeoutMs: 30 * 60_000, timeouts: { implement: 3_600_000 } });
    expect(phaseTimeoutMs(project, "implement")).toBe(3_600_000);
    expect(phaseTimeoutMs(project, "checks")).toBe(30 * 60_000);
  });

  test("run timeout summary tells an active run from a silent one", () => {
    const tool = { at: at("10:25:00"), message: "Bash:  bun run\ntest" };
    expect(runTimeoutSummary(30 * 60_000, undefined, tool, at("10:30:00"))).toBe(
      "run timeout after 30 min while still active (last tool: Bash: bun run test)",
    );
    expect(runTimeoutSummary(30 * 60_000, 2 * 60_000, tool, at("10:30:00"))).toBe(
      "run timeout after 30 min (no tool activity for 5 min; last tool: Bash: bun run test)",
    );
    expect(runTimeoutSummary(60 * 60_000, undefined, undefined, at("10:30:00"))).toBe(
      "run timeout after 60 min (no tool activity)",
    );
  });
});

describe("implement prompt", () => {
  test("names the check commands and asks for targeted tests only", () => {
    const text = implementTestingGuidance(testProject({ timeouts: { implement: 45 * 60_000 } }));
    expect(text).toContain("- test: `bun run test`");
    expect(text).toContain("- typecheck: `bun run typecheck`");
    expect(text).toMatch(/Do not run the whole test suite/);
    expect(text).toContain("vitest run path/to/file.test.ts");
    expect(text).toContain("stopped after 45 min");
    expect(implementTestingGuidance(testProject({ checks: [] }))).toBe("");
  });

  test("appends the operator's implement guidance and passes the project limits", async () => {
    const h = createHarness({
      project: {
        implementGuidance: "Use `npx jest <file>` for targeted runs.",
        idleTimeoutMs: 120_000,
        timeouts: { implement: 3_600_000 },
      },
    });
    await h.setup();
    h.tickets.add("Guided");
    await h.drain(10);
    const req = h.implementer.calls.find((c) => c.phase === "implement");
    expect(req?.prompt).toContain(
      "Project guidance (source: operator project configuration):\nUse `npx jest <file>` for targeted runs.",
    );
    expect(req?.prompt).toContain("Testing during implement");
    expect(req?.timeoutMs).toBe(3_600_000);
    expect(req?.idleTimeoutMs).toBe(120_000);
    const spike = h.implementer.calls.find((c) => c.phase === "spike");
    expect(spike?.timeoutMs).toBe(60_000);
    expect(h.sandbox.calls.every((c) => c.timeoutMs === 60_000)).toBe(true);
  });
});

describe("run timeout while still active", () => {
  test("records the timeout distinctly, with the last tool call", async () => {
    const h = createHarness({
      project: { timeouts: { implement: 80 } },
      implement: (_req, _call, signal, emit) =>
        new Promise((resolve) => {
          emit("tool", "Bash: bun run test --all");
          signal.addEventListener("abort", () => resolve({ status: "cancelled", summary: "x" }));
        }),
    });
    await h.setup();
    const t = h.tickets.add("Slow suite");
    let runId: string | undefined;
    for (let i = 0; i < 20 && !runId; i++) {
      await h.reconciler.tick();
      const w = await h.store.getWorkflow("pilot", t.id);
      if (w?.status === "running" && w.phase === "implement") runId = w.currentRunId;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(runId).toBeDefined();
    await h.reconciler.idle();
    const w = await h.store.getWorkflow("pilot", t.id);
    expect(w?.lastError).toBe(
      "run timeout after 0 min while still active (last tool: Bash: bun run test --all)",
    );
    expect(w?.status).toBe("pending");
    const run = await h.store.getRun(runId as string);
    expect(run?.status).toBe("timeout");
  });
});
