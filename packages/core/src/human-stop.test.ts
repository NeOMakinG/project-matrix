import { describe, expect, test } from "vitest";
import { createHarness } from "./testing/harness.js";

/** Implementer that blocks until aborted, reporting the abort like a killed runner would. */
function hangingImplement(started: { count: number }) {
  return (_req: unknown, _call: number, signal: AbortSignal) =>
    new Promise<{ status: "cancelled"; summary: string }>((resolve) => {
      started.count++;
      signal.addEventListener("abort", () =>
        resolve({ status: "cancelled", summary: "model: I was about to finish" }),
      );
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

describe("human stop (ticket moved to Backlog/Todo)", () => {
  test("cancels the running run, blocks without budget, never moves the ticket back", async () => {
    const started = { count: 0 };
    const h = createHarness({ maxRequeuesPerDay: 1, implement: hangingImplement(started) });
    await h.setup();
    const t = h.tickets.add("Stop me");
    const running = await untilRunning(h, t.id);
    const runId = running.currentRunId as string;
    const statusBefore = h.tickets.tickets.get(t.id)?.status;

    h.tickets.humanMoves.set(t.id, "Backlog");
    await h.reconciler.tick();
    await h.reconciler.idle();

    const w = await h.store.getWorkflow("pilot", t.id);
    expect(w?.status).toBe("blocked");
    expect(w?.lastError).toBe("stopped by human (moved to Backlog)");
    expect(w?.attempt).toBe(running.attempt);
    expect(w?.requeueCount ?? 0).toBe(0);
    const run = await h.store.getRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.summary).toBe("stopped by human (moved to Backlog)");
    // Matrix wrote nothing that moves the ticket and added no needs-human label.
    expect(h.tickets.tickets.get(t.id)?.status).toBe(statusBefore);
    expect(h.tickets.tickets.get(t.id)?.labels).not.toContain("needs-human");
    // Further ticks while it sits in Backlog start nothing.
    for (let i = 0; i < 3; i++) await h.reconciler.tick();
    expect(started.count).toBe(1);
  });

  test("moving it to Ready restarts normally without consuming restart budget", async () => {
    const started = { count: 0 };
    const h = createHarness({ maxRequeuesPerDay: 1, implement: hangingImplement(started) });
    await h.setup();
    const t = h.tickets.add("Resume me");
    for (let round = 0; round < 3; round++) {
      await untilRunning(h, t.id);
      h.tickets.humanMoves.set(t.id, "Todo");
      await h.reconciler.tick();
      await h.reconciler.idle();
      expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("blocked");
      h.tickets.humanMoves.delete(t.id);
      await h.tickets.update(t.id, { status: "ready" });
    }
    // Three restarts with a limit of one per day: none counted as flapping.
    await untilRunning(h, t.id);
    expect(started.count).toBe(4);
    const w = await h.store.getWorkflow("pilot", t.id);
    expect(w?.requeueCount ?? 0).toBe(0);
    expect(h.tickets.comments.some((c) => c.body.includes("did not restart"))).toBe(false);
    h.reconciler.stop();
    await h.reconciler.idle();
  });

  test("a queued (pending) workflow is stopped before it runs", async () => {
    const started = { count: 0 };
    const h = createHarness({ implement: hangingImplement(started) });
    await h.setup();
    const t = h.tickets.add("Queued");
    h.tickets.humanMoves.set(t.id, "Backlog");
    await h.reconciler.tick();
    await h.reconciler.idle();
    const w = await h.store.getWorkflow("pilot", t.id);
    expect(w?.status).toBe("blocked");
    expect(h.implementer.calls).toHaveLength(0);
  });

  test("a model-written 'stopped by human' error does not bypass the restart cap", async () => {
    const h = createHarness({
      maxRequeuesPerDay: 1,
      implement: () => ({ status: "failed", summary: "stopped by human (moved to Backlog)" }),
    });
    await h.setup();
    const t = h.tickets.add("Spoof");
    await h.drain();
    for (let i = 0; i < 2; i++) {
      await h.tickets.update(t.id, { status: "ready" });
      await h.drain();
    }
    const w = await h.store.getWorkflow("pilot", t.id);
    expect(w?.status).toBe("blocked");
    expect(w?.stoppedBy).toBeUndefined();
    expect(h.tickets.comments.some((c) => c.body.includes("did not restart"))).toBe(true);
  });

  test("stopWorkflow on an inactive workflow is a no-op", async () => {
    const h = createHarness();
    await h.setup();
    expect(await h.reconciler.stopWorkflow("pilot", "T-404", "stopped by human")).toBeNull();
  });
});
