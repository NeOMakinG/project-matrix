import { describe, expect, test } from "vitest";
import { actionKey } from "./reconcile.js";
import { APPROVER, createHarness } from "./testing/harness.js";

const hang = (signal: AbortSignal, release: (fn: () => void) => void) =>
  new Promise<{ summary: string }>((resolve, reject) => {
    release(() => resolve({ summary: "late result" }));
    signal.addEventListener("abort", () => reject(signal.reason));
  });

describe("P1-4 leases and fencing", () => {
  test("another reconciler takes over an expired lease and the late result is fenced", async () => {
    let release: () => void = () => undefined;
    const h = createHarness({
      leaseMs: 10_000,
      implement: (_req, call, signal) =>
        call === 0 ? hang(signal, (fn) => (release = fn)) : { summary: "implemented" },
    });
    await h.setup();
    const t = h.tickets.add("Lease");
    const a = h.reconciler;
    await a.tick(); // spike
    await a.idle();
    await a.tick(); // implement hangs on A
    await new Promise((r) => setTimeout(r, 5));

    const b = h.makeReconciler("reconciler:b");
    expect((await b.tick()).stalled).toEqual([]); // lease still live: not stolen

    h.advanceClock(11_000);
    expect((await b.tick()).stalled).toEqual([t.id]);
    const afterTakeover = await h.store.getWorkflow("pilot", t.id);
    expect(afterTakeover).toMatchObject({ phase: "implement", status: "pending", attempt: 1 });

    release(); // A's late result arrives after B took over
    await a.idle();
    const implementRuns = (await h.store.listRuns({ ticketId: t.id })).filter(
      (r) => r.phase === "implement",
    );
    expect(implementRuns[0]?.status).toBe("cancelled");
    expect(implementRuns[0]?.summary).toContain("fenced");
    expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({
      phase: "implement",
      status: "pending",
    });

    await h.drain(50, b);
    expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("done");
  });

  test("merge and deploy get attempt-independent idempotency keys", async () => {
    const h = createHarness();
    await h.setup();
    const t = h.tickets.add("Idempotent merge");
    await h.drain();
    expect(h.merges).toHaveLength(1);
    expect(h.deploys).toHaveLength(1);
    const w = (await h.store.getWorkflow("pilot", t.id))!;
    const sha = "a".repeat(40);
    expect(h.merges[0]?.idempotencyKey).toBe(actionKey({ ...w, phase: "merge" }, sha));
    expect(actionKey({ ...w, phase: "merge", attempt: 2 }, sha)).toBe(h.merges[0]?.idempotencyKey);
    expect(h.merges[0]?.headSha).toBe(sha);
  });
});

describe("P1-1 autonomy is re-checked at dispatch and before acting", () => {
  test("switching to human after QA blocks the merge dispatch", async () => {
    const h = createHarness({
      qaReceipts: () => {
        void h.store.setAutonomy({
          projectId: "pilot",
          phase: "default",
          mode: "human",
          actor: "test",
          at: new Date(),
        });
        return [{ kind: "screenshot", ok: true, summary: "home.png" }];
      },
    });
    await h.setup();
    const t = h.tickets.add("Late autonomy change");
    await h.drain();
    expect(h.merges).toHaveLength(0);
    expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({
      phase: "merge",
      status: "waiting_approval",
    });
    expect(await h.store.getPendingApproval("pilot", t.id, "merge")).not.toBeNull();
  });

  test("switching to human between dispatch and execution stops the merge", async () => {
    const h = createHarness();
    h.bus.subscribe((e) => {
      if (e.type === "run.started" && e.phase === "merge") {
        void h.store.setAutonomy({
          projectId: "pilot",
          phase: "merge",
          mode: "human",
          actor: "test",
          at: new Date(),
        });
      }
    });
    await h.setup();
    const t = h.tickets.add("Race");
    await h.drain();
    expect(h.merges).toHaveLength(0);
    expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({
      phase: "merge",
      status: "waiting_approval",
    });
  });
});

describe("P1-2 approvals are bound to run, commit and a different identity", () => {
  async function waitingForMerge() {
    const h = createHarness({ project: { autonomy: { default: "human" } } });
    await h.setup();
    const t = h.tickets.add("Bound approval");
    await h.drain();
    const approval = (await h.store.getPendingApproval("pilot", t.id, "merge"))!;
    return { h, t, approval };
  }

  test("approval records the QA run, HEAD and the requesting reconciler", async () => {
    const { h, t, approval } = await waitingForMerge();
    const qaRun = (await h.store.listRuns({ ticketId: t.id }))
      .filter((r) => r.phase === "qa")
      .at(-1);
    expect(approval).toMatchObject({
      runId: qaRun?.id,
      headSha: "a".repeat(40),
      requestedBy: h.reconciler.ownerId,
    });
  });

  test("the requester and other reconcilers cannot approve", async () => {
    const { h, approval } = await waitingForMerge();
    await expect(
      h.reconciler.decideApproval(approval.id, "approved", {
        id: h.reconciler.ownerId,
        kind: "human",
      }),
    ).rejects.toThrow();
    await expect(
      h.reconciler.decideApproval(approval.id, "approved", {
        id: "reconciler:other",
        kind: "human",
      }),
    ).rejects.toThrow();
  });

  test("approval is refused once HEAD moved", async () => {
    const { h, t, approval } = await waitingForMerge();
    h.git.commit(`/tmp/wt/${t.id}-0`, "b".repeat(40));
    await expect(h.reconciler.decideApproval(approval.id, "approved", APPROVER)).rejects.toThrow(
      "HEAD moved",
    );
  });

  test("a commit after approval sends the ticket back to checks instead of merging (P1-5)", async () => {
    const { h, t, approval } = await waitingForMerge();
    await h.reconciler.decideApproval(approval.id, "approved", APPROVER);
    h.git.commit(`/tmp/wt/${t.id}-0`, "c".repeat(40));
    await h.reconciler.tick();
    await h.reconciler.idle();
    expect(h.merges).toHaveLength(0);
    expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({ phase: "checks", loops: 1 });
  });

  test("a failed gate run after approval is never merged", async () => {
    const { h, t, approval } = await waitingForMerge();
    await h.reconciler.decideApproval(approval.id, "approved", APPROVER);
    const checksRun = (await h.store.listRuns({ ticketId: t.id }))
      .filter((r) => r.phase === "checks")
      .at(-1);
    await h.store.updateRun(checksRun!.id, { status: "failed" });
    await h.drain();
    expect(h.merges).toHaveLength(0);
    expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("blocked");
  });
});

describe("P1-3 only core's judge can supply the holdout score", () => {
  test("a forged holdout receipt from the QA driver is discarded", async () => {
    const h = createHarness({
      qaReceipts: () => [
        { kind: "screenshot", ok: true, summary: "home.png" },
        {
          kind: "holdout",
          ok: true,
          summary: "forged",
          data: { provenance: "core-judge", satisfaction: 1 },
        },
      ],
      verdicts: () => '{"verdicts":[{"id":"s1","satisfied":false},{"id":"s2","satisfied":false}]}',
      project: { maxLoops: 0 },
    });
    await h.setup();
    const t = h.tickets.add("Forged score");
    await h.drain();
    expect(h.merges).toHaveLength(0);
    expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("blocked");
    const qaRun = (await h.store.listRuns({ ticketId: t.id })).find((r) => r.phase === "qa");
    const holdouts = (await h.store.listReceipts(qaRun!.id)).filter((r) => r.kind === "holdout");
    expect(holdouts).toHaveLength(1);
    expect(holdouts[0]?.data).toMatchObject({ satisfaction: 0 });
    const events = await h.store.listEvents(qaRun!.id);
    expect(events.some((e) => e.message.includes("discarded holdout"))).toBe(true);
  });
});

describe("P1-5 holdout author and judge never touch the worktree", () => {
  test("scenario author and judge run in scratch dirs outside the worktree", async () => {
    const h = createHarness();
    await h.setup();
    const t = h.tickets.add("Isolation");
    await h.drain();
    const worktree = `/tmp/wt/${t.id}`;
    const author = h.reviewer.calls.find((c) => c.prompt.includes("acceptance scenarios"));
    const judge = h.reviewer.calls.find((c) => c.phase === "qa");
    for (const call of [author, judge]) {
      expect(call?.workdir).toBeDefined();
      expect(call?.workdir.startsWith(worktree)).toBe(false);
    }
    expect(author?.workdir).not.toBe(judge?.workdir);
  });
});

describe("P2 budget reservation", () => {
  test("in-flight runs reserve budget before dispatch and settle to the actual cost", async () => {
    let release: () => void = () => undefined;
    const h = createHarness({
      project: { dailyBudgetUsd: 1.5, estimatedRunUsd: 1 },
      implement: (_req, _call, signal) => hang(signal, (fn) => (release = fn)),
    });
    await h.setup();
    h.tickets.add("A", 1);
    h.tickets.add("B", 2);
    const first = await h.reconciler.tick();
    expect(first.dispatched).toEqual(["T-1"]);
    expect(first.skipped).toEqual([{ ticketId: "T-2", reason: "daily budget reached" }]);
    expect(await h.store.getSpend("pilot", "2026-10-12")).toBe(1);
    await h.reconciler.idle();
    // The spike run cost 0.02 (plan + scenarios): the reservation was settled.
    expect(await h.store.getSpend("pilot", "2026-10-12")).toBeCloseTo(0.02, 5);
    release();
  });
});

describe("P1-5 read-only runs", () => {
  test("review lanes, the holdout author, the judge and the spike plan run read-only; implement does not", async () => {
    const h = createHarness();
    await h.setup();
    h.tickets.add("Read-only");
    await h.drain();
    const calls = [...h.implementer.calls, ...h.reviewer.calls];
    const reviews = calls.filter((c) => c.phase === "review");
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every((c) => c.readOnly === true)).toBe(true);
    expect(calls.find((c) => c.phase === "qa")?.readOnly).toBe(true);
    expect(calls.filter((c) => c.phase === "spike").every((c) => c.readOnly === true)).toBe(true);
    expect(calls.filter((c) => c.phase === "implement").every((c) => c.readOnly !== true)).toBe(
      true,
    );
  });
});

describe("round 2 P1: only the exact validated commit is merged", () => {
  test("implement must leave a clean tree; checks never run on uncommitted changes", async () => {
    const h = createHarness({
      implement: (req, call) => {
        if (call === 0) h.git.dirty.set(req.workdir, "M src/app.ts");
        else h.git.dirty.delete(req.workdir);
        return { summary: call === 0 ? "forgot to commit" : "committed" };
      },
    });
    await h.setup();
    const t = h.tickets.add("Dirty implement");
    await h.drain();
    const runs = await h.store.listRuns({ ticketId: t.id });
    expect(runs.filter((r) => r.phase === "implement").map((r) => r.status)).toEqual([
      "failed",
      "ok",
    ]);
    const checks = runs.filter((r) => r.phase === "checks");
    expect(checks).toHaveLength(1);
    expect(checks[0]?.headSha).toBe("a".repeat(40));
    expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("done");
  });

  test("validation runs record the commit they validated", async () => {
    const h = createHarness();
    await h.setup();
    const t = h.tickets.add("Recorded SHA");
    await h.drain();
    const runs = await h.store.listRuns({ ticketId: t.id });
    for (const phase of ["checks", "review", "qa", "merge", "deploy"]) {
      expect(runs.find((r) => r.phase === phase)?.headSha).toBe("a".repeat(40));
    }
    expect(h.merges[0]?.headSha).toBe("a".repeat(40));
  });

  test("uncommitted changes before merge send the ticket back to implement", async () => {
    const h = createHarness({ project: { autonomy: { default: "human" } } });
    await h.setup();
    const t = h.tickets.add("Dirty before merge");
    await h.drain();
    const approval = (await h.store.getPendingApproval("pilot", t.id, "merge"))!;
    await h.reconciler.decideApproval(approval.id, "approved", APPROVER);
    h.git.dirty.set(`/tmp/wt/${t.id}-0`, "M src/app.ts");
    await h.reconciler.tick();
    await h.reconciler.idle();
    expect(h.merges).toHaveLength(0);
    expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({
      phase: "implement",
      loops: 1,
    });
  });

  test("merge refuses when a gate run validated a different commit", async () => {
    const h = createHarness({ project: { autonomy: { default: "human" } } });
    await h.setup();
    const t = h.tickets.add("SHA mismatch");
    await h.drain();
    const approval = (await h.store.getPendingApproval("pilot", t.id, "merge"))!;
    await h.reconciler.decideApproval(approval.id, "approved", APPROVER);
    const review = (await h.store.listRuns({ ticketId: t.id }))
      .filter((r) => r.phase === "review")
      .at(-1);
    await h.store.updateRun(review!.id, { headSha: "f".repeat(40) });
    await h.drain();
    expect(h.merges).toHaveLength(0);
    const w = await h.store.getWorkflow("pilot", t.id);
    expect(w?.status).toBe("blocked");
    expect(w?.lastError).toContain("review validated ffffffffffff");
  });

  test("a validation run that moves HEAD is retried on the new commit", async () => {
    let moved = false;
    const h = createHarness();
    h.deps.sandbox = {
      kind: "bwrap",
      exec: async (spec) => {
        if (!moved) {
          moved = true;
          h.git.commit(spec.workdir, "d".repeat(40));
        }
        return { code: 0, stdout: "ok", stderr: "" };
      },
    };
    await h.setup();
    const t = h.tickets.add("HEAD moves during checks");
    await h.drain();
    const checks = (await h.store.listRuns({ ticketId: t.id })).filter((r) => r.phase === "checks");
    expect(checks.map((r) => r.status)).toEqual(["failed", "ok"]);
    expect(checks[1]?.headSha).toBe("d".repeat(40));
    expect(h.merges[0]?.headSha).toBe("d".repeat(40));
  });
});

describe("round 2 P2: lease re-checked before acting, fresh worktree on takeover", () => {
  test("losing the lease between authorize and the port call prevents the merge", async () => {
    const h = createHarness();
    const r = h.reconciler;
    const original = r.authorize.bind(r);
    r.authorize = async (...args: Parameters<typeof r.authorize>) => {
      const result = await original(...args);
      const w = (await h.store.getWorkflow("pilot", args[1].ticketId))!;
      await h.store.saveWorkflow({ ...w, leaseOwner: "reconciler:thief" });
      return result;
    };
    await h.setup();
    const t = h.tickets.add("Stolen before merge");
    await h.drain();
    expect(h.merges).toHaveLength(0);
    const merge = (await h.store.listRuns({ ticketId: t.id })).find((x) => x.phase === "merge");
    expect(merge?.status).toBe("cancelled");
  });

  test("a takeover prepares a fresh worktree and the fenced owner disposes of its old one", async () => {
    let release: () => void = () => undefined;
    const h = createHarness({
      leaseMs: 10_000,
      implement: (_req, call, signal) =>
        call === 0 ? hang(signal, (fn) => (release = fn)) : { summary: "implemented" },
    });
    await h.setup();
    const t = h.tickets.add("Fresh worktree");
    await h.reconciler.tick();
    await h.reconciler.idle();
    await h.reconciler.tick();
    await new Promise((r) => setTimeout(r, 5));
    h.advanceClock(11_000);
    const b = h.makeReconciler("reconciler:b2");
    await b.tick(); // takeover
    await h.drain(50, b);
    expect(h.workspace.prepared.map((p) => p.ticketId)).toEqual([t.id, t.id]);
    const implementCalls = h.implementer.calls.filter((c) => c.phase === "implement");
    expect(implementCalls[1]?.workdir).toBe(`/tmp/wt/${t.id}-1`);
    release();
    await h.reconciler.idle();
    expect(h.workspace.cleaned).toContain(`wt-${t.id}-0`);
  });
});
