import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type AutonomyMode, PHASES, type Phase } from "../ports.js";
import { AutonomyConflictError, VersionConflictError } from "../store.js";
import { testProject } from "../testing/fakes.js";
import { createHarness } from "../testing/harness.js";
import { PgStore } from "./pg-store.js";

const url = process.env.MATRIX_TEST_DATABASE_URL;

describe.skipIf(!url)("PgStore against real Postgres", () => {
  let store: PgStore;

  beforeAll(async () => {
    store = await PgStore.connect(url as string);
  });

  afterAll(async () => {
    await store?.close();
  });

  test("concurrent same-value policy saves use history versions and roll back the loser", async () => {
    const projectId = `version-cas-${Date.now()}`;
    await store.upsertProject(testProject({ id: projectId, autonomy: { default: "human" } }));
    const before = await store.getProjectPolicy(projectId);
    const results = await Promise.allSettled([
      store.setAutonomyPolicy(projectId, { merge: "human" }, "human:first", before.version),
      store.setAutonomyPolicy(projectId, { merge: "human" }, "human:second", before.version),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await store.autonomyHistory(projectId)).toHaveLength(1);
    await expect(
      store.setAutonomyPolicy(projectId, { merge: "autonomous" }, "human:stale", before.version),
    ).rejects.toBeInstanceOf(AutonomyConflictError);
    expect(await store.autonomyHistory(projectId)).toHaveLength(1);
  });

  test("init CAS rejects policy ABA without partial project or history updates", async () => {
    const projectId = `init-policy-${Date.now()}`;
    await store.upsertProject(testProject({ id: projectId, autonomy: { default: "human" } }));
    const snapshot = await store.getProjectPolicy(projectId);
    await store.setAutonomyPolicy(projectId, { merge: "autonomous" }, "human:external");
    await store.setAutonomyPolicy(projectId, { merge: "human" }, "human:external");
    const current = await store.getProjectPolicy(projectId);
    expect(current.version).not.toBe(snapshot.version);
    await expect(
      store.saveInitializedProject(
        { ...snapshot.project, dailyBudgetUsd: 999 },
        { merge: "autonomous", deploy: "autonomous" },
        snapshot.version,
      ),
    ).rejects.toBeInstanceOf(AutonomyConflictError);
    expect(await store.getProjectPolicy(projectId)).toEqual(current);
  });

  test("concurrent autonomy PUTs compare-and-set and commit full policies with history", async () => {
    const projectId = `policy-${Date.now()}`;
    await store.upsertProject(testProject({ id: projectId, autonomy: { default: "human" } }));
    const expected = Object.fromEntries(PHASES.map((phase) => [phase, "human"])) as Record<
      Phase,
      AutonomyMode
    >;
    const results = await Promise.allSettled([
      store.setAutonomyPolicy(
        projectId,
        { merge: "gated", deploy: "autonomous" },
        "human:first",
        expected,
      ),
      store.setAutonomyPolicy(
        projectId,
        { merge: "autonomous", deploy: "gated" },
        "human:second",
        expected,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AutonomyConflictError);
    const history = await store.autonomyHistory(projectId);
    expect(history).toHaveLength(2);
    expect(history[0]!.actor).toBe(history[1]!.actor);
  });

  test("runs a full ticket through the loop on Postgres", async () => {
    const projectId = `pg-${Date.now()}`;
    const h = createHarness({ store, project: { id: projectId } });
    await h.setup();
    const t = h.tickets.add("Postgres-backed ticket");
    await h.drain();
    const w = await store.getWorkflow(projectId, t.id);
    expect(w?.status).toBe("done");
    const runs = await store.listRuns({ projectId, ticketId: t.id });
    expect(runs).toHaveLength(PHASES.length);
    expect(await store.getIndexedTicketTitle(projectId, t.id)).toBe(t.title);
    expect(await store.getIndexedTicketTitle(projectId, "missing")).toBeNull();
    expect(await store.getIndexedTicket(projectId, t.id)).toMatchObject({
      id: t.id,
      title: t.title,
      body: t.body,
      deps: [],
    });
    expect(await store.listIndexedTickets(projectId)).toHaveLength(1);
    expect(await store.getIndexedTicket(projectId, "missing")).toBeNull();
    expect(new Set(runs.map((r) => r.phase))).toEqual(new Set(PHASES));
    const events = await store.listEvents(runs[0]?.id ?? "");
    expect(events.length).toBeGreaterThan(0);
    expect(await store.getSpend(projectId, "2026-10-12")).toBeGreaterThan(0);
  }, 120_000);

  test("optimistic locking rejects stale workflow writes", async () => {
    const projectId = `lock-${Date.now()}`;
    await store.upsertProject(testProject({ id: projectId }));
    await store.createWorkflow({
      projectId,
      ticketId: "T-1",
      phase: "spike",
      status: "pending",
      attempt: 0,
      loops: 0,
      priority: 2,
      version: 0,
    });
    const w = await store.getWorkflow(projectId, "T-1");
    await store.saveWorkflow({ ...w!, status: "running" });
    await expect(store.saveWorkflow({ ...w!, status: "blocked" })).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    expect(await store.createWorkflow({ ...w!, version: 0 })).toBe(false);
  });

  test("autonomy overrides persist with history", async () => {
    const projectId = `auto-${Date.now()}`;
    await store.upsertProject(testProject({ id: projectId, autonomy: { default: "human" } }));
    await store.setAutonomy({
      projectId,
      phase: "merge",
      mode: "gated",
      actor: "valentin",
      at: new Date(),
    });
    const project = await store.getProject(projectId);
    expect(project?.autonomy).toEqual({ default: "human", merge: "gated" });
    expect(await store.autonomyHistory(projectId)).toHaveLength(1);
  });

  test("approvals can only be decided once", async () => {
    const id = `appr-${Date.now()}`;
    await store.createApproval({
      id,
      projectId: "p",
      ticketId: "T",
      phase: "merge",
      runId: "run-1",
      headSha: "abc",
      requestedBy: "reconciler:test",
      status: "pending",
      requestedAt: new Date(),
    });
    await store.decideApproval(id, "approved", { id: "user:valentin", kind: "human" });
    await expect(
      store.decideApproval(id, "rejected", { id: "user:someone", kind: "human" }),
    ).rejects.toThrow();
  });

  test("lease takeover fences the late result (P1-4)", async () => {
    let release: () => void = () => undefined;
    const projectId = `lease-${Date.now()}`;
    const h = createHarness({
      store,
      project: { id: projectId },
      leaseMs: 10_000,
      implement: (_req, call, signal) =>
        call === 0
          ? new Promise((resolve, reject) => {
              release = () => resolve({ summary: "late" });
              signal.addEventListener("abort", () => reject(signal.reason));
            })
          : { summary: "implemented" },
    });
    await h.setup();
    const t = h.tickets.add("Lease on Postgres");
    await h.reconciler.tick();
    await h.reconciler.idle();
    await h.reconciler.tick();
    await new Promise((r) => setTimeout(r, 50));
    const b = h.makeReconciler("reconciler:pg-b");
    expect((await b.tick()).stalled).toEqual([]);
    h.advanceClock(11_000);
    expect((await b.tick()).stalled).toEqual([t.id]);
    release();
    await h.reconciler.idle();
    const runs = await store.listRuns({ projectId, ticketId: t.id });
    expect(runs.find((r) => r.phase === "implement")?.status).toBe("cancelled");
    await h.drain(50, b);
    expect((await store.getWorkflow(projectId, t.id))?.status).toBe("done");
  }, 120_000);

  test("approvals are bound to run and HEAD on Postgres (P1-2)", async () => {
    const projectId = `bound-${Date.now()}`;
    const h = createHarness({ store, project: { id: projectId, autonomy: { default: "human" } } });
    await h.setup();
    const t = h.tickets.add("Bound");
    await h.drain();
    const approval = await store.getPendingApproval(projectId, t.id, "merge");
    expect(approval).toMatchObject({ headSha: "a".repeat(40), requestedBy: h.reconciler.ownerId });
    await expect(
      h.reconciler.decideApproval(approval!.id, "approved", {
        id: h.reconciler.ownerId,
        kind: "human",
      }),
    ).rejects.toThrow();
    await h.reconciler.decideApproval(approval!.id, "approved", {
      id: "user:valentin",
      kind: "human",
    });
    await h.drain();
    expect(await store.getWorkflow(projectId, t.id)).toMatchObject({
      phase: "deploy",
      status: "waiting_approval",
    });
  }, 120_000);

  test("approver kind persists and agent-approved or other-phase approvals never merge (PR #2)", async () => {
    const projectId = `phase-${Date.now()}`;
    const h = createHarness({ store, project: { id: projectId, autonomy: { default: "human" } } });
    await h.setup();
    const t = h.tickets.add("Phase-bound on Postgres");
    await h.drain();
    const qaRun = (await store.listRuns({ projectId, ticketId: t.id }))
      .filter((r) => r.phase === "qa")
      .at(-1)!;
    await store.createApproval({
      id: `forged-${projectId}`,
      projectId,
      ticketId: t.id,
      phase: "review",
      runId: qaRun.id,
      headSha: "a".repeat(40),
      requestedBy: "key:agent-1",
      status: "pending",
      requestedAt: new Date(),
    });
    await store.decideApproval(`forged-${projectId}`, "approved", {
      id: "user:valentin",
      kind: "human",
    });
    const merge = (await store.getPendingApproval(projectId, t.id, "merge"))!;
    await store.decideApproval(merge.id, "approved", { id: "key:agent-1", kind: "agent" });
    expect((await store.getApproval(merge.id))?.decidedByKind).toBe("agent");
    const w = (await store.getWorkflow(projectId, t.id))!;
    await store.saveWorkflow({ ...w, status: "pending" });
    await h.drain();
    expect(h.merges).toHaveLength(0);
    expect(await store.getWorkflow(projectId, t.id)).toMatchObject({
      phase: "merge",
      status: "waiting_approval",
    });
  }, 120_000);
});
