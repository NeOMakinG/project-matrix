import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PHASES } from "../ports.js";
import { VersionConflictError } from "../store.js";
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
      status: "pending",
      requestedAt: new Date(),
    });
    await store.decideApproval(id, "approved", "valentin");
    await expect(store.decideApproval(id, "rejected", "someone")).rejects.toThrow();
  });
});
