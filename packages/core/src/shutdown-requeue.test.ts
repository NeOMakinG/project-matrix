import { describe, expect, test } from "vitest";
import { INTERRUPTED_SUMMARY } from "./reconcile.js";
import { createHarness } from "./testing/harness.js";

/** Implementer that blocks until aborted, reporting the abort like a killed runner would. */
function hangingImplement(started: { count: number }) {
  return (_req: unknown, _call: number, signal: AbortSignal) =>
    new Promise<{ status: "cancelled"; summary: string }>((resolve) => {
      started.count++;
      signal.addEventListener("abort", () => resolve({ status: "cancelled", summary: "killed" }));
    });
}

async function untilRunning(h: ReturnType<typeof createHarness>, ticketId: string) {
  for (let i = 0; i < 20; i++) {
    const w = await h.store.getWorkflow("pilot", ticketId);
    if (w?.status === "running" && w.phase === "implement") return w;
    await h.reconciler.tick();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("never reached a running implement");
}

describe("reconciler shutdown (server restart mid-run)", () => {
  test("re-queues the interrupted run without counting an attempt, even across 3+ restarts", async () => {
    const started = { count: 0 };
    const h = createHarness({ implement: hangingImplement(started) });
    await h.setup();
    const t = h.tickets.add("Survive deploys");
    let reconciler = h.reconciler;
    const first = await untilRunning(h, t.id);
    for (let restart = 1; restart <= 4; restart++) {
      const running = await h.store.getWorkflow("pilot", t.id);
      const runId = running?.currentRunId as string;
      reconciler.stop();
      await reconciler.idle();
      // The stopping instance never dispatches the re-queued run itself.
      await reconciler.tick();
      const w = await h.store.getWorkflow("pilot", t.id);
      expect(w?.status).toBe("pending");
      expect(w?.phase).toBe("implement");
      expect(w?.attempt).toBe(first.attempt);
      expect(w?.lastError).toBe(INTERRUPTED_SUMMARY);
      const run = await h.store.getRun(runId);
      expect(run?.status).toBe("cancelled");
      expect(run?.summary).toBe(INTERRUPTED_SUMMARY);
      expect(h.tickets.tickets.get(t.id)?.labels).not.toContain("needs-human");
      // The restarted server picks it up again.
      reconciler = h.makeReconciler(`reconciler:restart-${restart}`);
      for (let i = 0; i < 20; i++) {
        await reconciler.tick();
        if (started.count === restart + 1) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("running");
      expect(started.count).toBe(restart + 1);
    }
    reconciler.stop();
    await reconciler.idle();
  });
});
