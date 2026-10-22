import { describe, expect, test } from "vitest";
import { scenarioRejectionReason } from "./holdout.js";
import { stepKey } from "./reconcile.js";
import { APPROVER, createHarness } from "./testing/harness.js";

describe("reconcile loop", () => {
  test("takes a ready ticket from spike to done with receipts and lessons", async () => {
    const h = createHarness({
      findings: () =>
        '{"findings":[{"severity":"P3","title":"rename helper","file":"src/a.ts:3"}]}',
    });
    await h.setup();
    const t = h.tickets.add("Sign-up flow");
    await h.drain();

    const w = await h.store.getWorkflow("pilot", t.id);
    expect(w?.status).toBe("done");
    expect(h.tickets.tickets.get(t.id)?.status).toBe("done");
    expect(h.workspace.cleaned).toEqual([`wt-${t.id}-0`]);

    const phases = (await h.store.listRuns({ ticketId: t.id })).map((r) => r.phase);
    expect(phases).toEqual([
      "spike",
      "implement",
      "checks",
      "review",
      "qa",
      "merge",
      "deploy",
      "verify",
      "compound",
    ]);

    // Reviewers never use the implementer's model.
    const reviewModels = h.reviewer.calls.filter((c) => c.phase === "review").map((c) => c.model);
    expect(reviewModels.length).toBe(2);
    expect(reviewModels.every((m) => m !== "fable-5-1")).toBe(true);

    // Holdout scenarios exist outside the worktree and were judged.
    expect(await h.holdout.load("pilot", t.id)).toHaveLength(2);
    const qaRun = (await h.store.listRuns({ ticketId: t.id })).find((r) => r.phase === "qa");
    const qaReceipts = await h.store.listReceipts(qaRun?.id ?? "");
    expect(qaReceipts.find((r) => r.kind === "holdout")?.data).toMatchObject({ satisfaction: 1 });

    expect(await h.store.listLessons("pilot")).toHaveLength(2);
    expect(h.tickets.comments.some((c) => c.body.startsWith("Spike plan"))).toBe(true);
    expect(h.sandbox.calls.every((c) => c.network === "none")).toBe(true);
  });

  test("a P1 review finding sends the ticket back to implement once", async () => {
    const h = createHarness({
      findings: (_req, call) =>
        call === 0
          ? '{"findings":[{"severity":"P1","title":"missing auth check"}]}'
          : '{"findings":[]}',
    });
    await h.setup();
    const t = h.tickets.add("Admin page");
    await h.drain();
    const implementCalls = h.implementer.calls.filter((c) => c.phase === "implement");
    expect(implementCalls).toHaveLength(2);
    expect(implementCalls[1]?.prompt).toContain("missing auth check");
    expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("done");
  });

  test("respects per-project and per-model concurrency limits", async () => {
    const h = createHarness({ limits: { perProject: 1 } });
    await h.setup();
    h.tickets.add("A", 1);
    h.tickets.add("B", 2);
    const report = await h.reconciler.tick();
    expect(report.dispatched).toEqual(["T-1"]);
    expect(report.skipped).toEqual([{ ticketId: "T-2", reason: "project limit" }]);
    await h.reconciler.idle();

    const h2 = createHarness({ limits: { perModel: { "fable-5-1": 1 } } });
    await h2.setup();
    h2.tickets.add("A");
    h2.tickets.add("B");
    const r2 = await h2.reconciler.tick();
    expect(r2.dispatched).toHaveLength(1);
    expect(r2.skipped[0]?.reason).toBe("model limit fable-5-1");
    await h2.reconciler.idle();
  });

  test("replays a completed step instead of running it again", async () => {
    const h = createHarness();
    await h.setup();
    const t = h.tickets.add("Idempotent");
    await h.reconciler.tick(); // creates workflow + dispatches spike
    await h.reconciler.idle();
    const w = await h.store.getWorkflow("pilot", t.id);
    expect(w?.phase).toBe("implement");

    // Simulate a crash after the implement step finished but before the transition was saved.
    const key = stepKey(w!);
    await h.store.startStep({ key, runId: "earlier", phase: "implement", input: {} });
    await h.store.completeStep(key, {
      output: {
        ok: true,
        summary: "done earlier",
        receipts: [],
        runStatus: "ok",
        model: "fable-5-1",
      },
      ok: true,
      completedAt: new Date(),
    });
    const report = await h.reconciler.tick();
    expect(report.replayed).toEqual([t.id]);
    expect(h.implementer.calls.filter((c) => c.phase === "implement")).toHaveLength(0);
    expect((await h.store.getWorkflow("pilot", t.id))?.phase).toBe("checks");
  });

  test("human autonomy pauses for merge and deploy approvals", async () => {
    const h = createHarness({ project: { autonomy: { default: "human" } } });
    await h.setup();
    const t = h.tickets.add("Pricing page");
    await h.drain();
    let w = await h.store.getWorkflow("pilot", t.id);
    expect(w).toMatchObject({ phase: "merge", status: "waiting_approval" });
    const merge = await h.store.getPendingApproval("pilot", t.id, "merge");
    expect(merge).not.toBeNull();
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(true);

    await h.reconciler.decideApproval(merge!.id, "approved", APPROVER);
    await h.drain();
    w = await h.store.getWorkflow("pilot", t.id);
    expect(w).toMatchObject({ phase: "deploy", status: "waiting_approval" });

    const deploy = await h.store.getPendingApproval("pilot", t.id, "deploy");
    await h.reconciler.decideApproval(deploy!.id, "approved", APPROVER);
    await h.drain();
    expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("done");
  });

  test("autonomy can change at run time and is audited", async () => {
    const h = createHarness({ project: { autonomy: { default: "human" } } });
    await h.setup();
    const t = h.tickets.add("Switch");
    await h.reconciler.setAutonomy("pilot", "default", "autonomous", "valentin", "trust earned");
    await h.drain();
    expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("done");
    expect(await h.store.autonomyHistory("pilot")).toMatchObject([
      { mode: "autonomous", actor: "valentin" },
    ]);
  });

  test("stops dispatching when the daily budget is spent", async () => {
    const h = createHarness({ project: { dailyBudgetUsd: 0.005 } });
    await h.setup();
    h.tickets.add("Expensive");
    await h.reconciler.tick();
    await h.reconciler.idle();
    const report = await h.reconciler.tick();
    expect(report.skipped[0]?.reason).toBe("daily budget reached");
  });

  test("a rejected first scenario batch is logged with a redacted reason before the retry", async () => {
    let calls = 0;
    const secretThen = "HOLDOUT-SECRET-THEN-CLAUSE works";
    const h = createHarness({
      scenarios: () =>
        calls++ === 0
          ? { summary: JSON.stringify({ scenarios: [{ id: "s1", given: secretThen, when: "w" }] }) }
          : {
              summary: JSON.stringify({
                scenarios: [
                  {
                    id: "s1",
                    given: "a user",
                    when: "they sign up",
                    then: "they see the dashboard",
                  },
                ],
              }),
            },
    });
    await h.setup();
    const t = h.tickets.add("Sign-up flow");
    await h.drain();
    expect(calls).toBe(2);
    const spike = (await h.store.listRuns({ ticketId: t.id })).find((r) => r.phase === "spike");
    const events = await h.store.listEvents(spike?.id ?? "");
    expect(events.map((e) => e.message)).toContain(
      "private scenario batch 1 rejected: scenario 0 is missing given/when/then",
    );
    expect(JSON.stringify(events)).not.toContain(secretThen);
  });

  test("scenario rejection reasons only pass the validator's fixed wording", () => {
    expect(scenarioRejectionReason(new SyntaxError('Unexpected token "secret holdout"'))).toBe(
      "model output was not valid JSON",
    );
    expect(scenarioRejectionReason(new Error("invalid scenario count"))).toBe(
      "invalid scenario count",
    );
    expect(scenarioRejectionReason(new Error("then: the user sees HOLDOUT text"))).toBe(
      "unrecognized validation failure",
    );
  });

  test("a failing private scenario writer surfaces its redacted cause, not a bare summary", async () => {
    const h = createHarness({
      scenarios: () => {
        throw new Error(
          'selector_not_found: No Orca workspace matched "path:/scratch/x" Bearer sk-abcdefghijklmnop1234',
        );
      },
    });
    await h.setup();
    const t = h.tickets.add("Sign-up flow");
    await h.drain();
    const spikes = (await h.store.listRuns({ ticketId: t.id })).filter((r) => r.phase === "spike");
    expect(spikes.length).toBeGreaterThan(0);
    const events = (await Promise.all(spikes.map((r) => h.store.listEvents(r.id)))).flat();
    const cause = events.find((e) =>
      e.message.startsWith("Private QA scenario preparation failed"),
    );
    expect(cause?.message).toContain("selector_not_found");
    expect(cause?.message).not.toContain("sk-abcdefghijklmnop1234");
    expect(JSON.stringify(spikes)).not.toContain("sk-abcdefghijklmnop1234");
  });
});
