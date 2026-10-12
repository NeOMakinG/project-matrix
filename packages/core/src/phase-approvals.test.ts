import { describe, expect, test } from "vitest";
import { type Actor, MemoryStore } from "./store.js";
import { APPROVER, createHarness } from "./testing/harness.js";

/** Drives a human-mode ticket until it waits for the merge approval. */
async function waitingForMerge(store = new MemoryStore()) {
  const h = createHarness({ store, project: { autonomy: { default: "human" } } });
  await h.setup();
  const t = h.tickets.add("Phase-bound approvals");
  await h.drain();
  const qaRun = (await h.store.listRuns({ ticketId: t.id }))
    .filter((r) => r.phase === "qa")
    .at(-1)!;
  const w = (await h.store.getWorkflow("pilot", t.id))!;
  expect(w).toMatchObject({ phase: "merge", status: "waiting_approval" });
  return { h, t, qaRun, headSha: "a".repeat(40) };
}

describe("cross-phase approval attack", () => {
  test("an approved `review` approval bound to the same run and commit never authorizes a merge", async () => {
    const { h, t, qaRun, headSha } = await waitingForMerge();
    // Attacker gets an approval for another phase approved, bound to the exact QA run and HEAD.
    await h.store.createApproval({
      id: "forged-review",
      projectId: "pilot",
      ticketId: t.id,
      phase: "review",
      runId: qaRun.id,
      headSha,
      requestedBy: "key:agent-1",
      status: "pending",
      requestedAt: new Date(),
    });
    await h.store.decideApproval("forged-review", "approved", {
      id: "user:valentin",
      kind: "human",
    });
    // ...and forces the workflow out of waiting_approval.
    const w = (await h.store.getWorkflow("pilot", t.id))!;
    await h.store.saveWorkflow({ ...w, status: "pending" });

    await h.drain();
    expect(h.merges).toHaveLength(0);
    expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({
      phase: "merge",
      status: "waiting_approval",
    });
  });

  test("still holds when a store adapter ignores the phase filter", async () => {
    const store = new MemoryStore();
    const listApprovals = store.listApprovals.bind(store);
    store.listApprovals = async (projectId, ticketId) => [
      ...(await listApprovals(projectId, ticketId, "review")),
      ...(await listApprovals(projectId, ticketId, "merge")),
    ];
    const { h, t, qaRun, headSha } = await waitingForMerge(store);
    await h.store.createApproval({
      id: "forged-review-2",
      projectId: "pilot",
      ticketId: t.id,
      phase: "review",
      runId: qaRun.id,
      headSha,
      requestedBy: "key:agent-1",
      status: "pending",
      requestedAt: new Date(),
    });
    await h.store.decideApproval("forged-review-2", "approved", {
      id: "user:valentin",
      kind: "human",
    });
    const w = (await h.store.getWorkflow("pilot", t.id))!;
    await h.store.saveWorkflow({ ...w, status: "pending" });
    await h.drain();
    expect(h.merges).toHaveLength(0);
  });
});

describe("approver kind", () => {
  test("agents cannot approve a merge, as an Approver or as a non-user identity string", async () => {
    const { h, t } = await waitingForMerge();
    const approval = (await h.store.getPendingApproval("pilot", t.id, "merge"))!;
    await expect(
      h.reconciler.decideApproval(approval.id, "approved", { id: "key:agent-1", kind: "agent" }),
    ).rejects.toThrow("human approver");
    // Bare identity strings are rejected outright, even ones that look human.
    for (const bare of ["key:agent-1", "user:valentin"]) {
      await expect(
        h.reconciler.decideApproval(approval.id, "approved", bare as unknown as Actor),
      ).rejects.toThrow("structured Actor");
    }
    await expect(
      h.reconciler.decideApproval(approval.id, "approved", { id: "", kind: "human" }),
    ).rejects.toThrow("structured Actor");
    await h.reconciler.decideApproval(approval.id, "approved", APPROVER);
    await h.drain();
    expect(h.merges).toHaveLength(1);
  });

  test("an approval marked approved by an agent directly in the store is ignored at merge time", async () => {
    const { h, t } = await waitingForMerge();
    const approval = (await h.store.getPendingApproval("pilot", t.id, "merge"))!;
    await h.store.decideApproval(approval.id, "approved", { id: "key:agent-1", kind: "agent" });
    const w = (await h.store.getWorkflow("pilot", t.id))!;
    await h.store.saveWorkflow({ ...w, status: "pending" });
    await h.drain();
    expect(h.merges).toHaveLength(0);
    expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({
      phase: "merge",
      status: "waiting_approval",
    });
  });

  test("a human run owner cannot approve their own run", async () => {
    const { h, t, qaRun } = await waitingForMerge();
    const approval = (await h.store.getPendingApproval("pilot", t.id, "merge"))!;
    await h.store.updateRun(qaRun.id, { ownerId: "user:valentin" });
    await expect(h.reconciler.decideApproval(approval.id, "approved", APPROVER)).rejects.toThrow(
      "initiator",
    );
  });

  test("deploy approvals are bound to phase `deploy` and need a human too", async () => {
    const { h, t } = await waitingForMerge();
    const merge = (await h.store.getPendingApproval("pilot", t.id, "merge"))!;
    await h.reconciler.decideApproval(merge.id, "approved", APPROVER);
    await h.drain();
    const deploy = (await h.store.getPendingApproval("pilot", t.id, "deploy"))!;
    expect(deploy.phase).toBe("deploy");
    await expect(
      h.reconciler.decideApproval(deploy.id, "approved", { id: "key:agent-1", kind: "agent" }),
    ).rejects.toThrow();
    // The approved merge approval cannot be reused for the deploy.
    const w = (await h.store.getWorkflow("pilot", t.id))!;
    await h.store.saveWorkflow({ ...w, status: "pending" });
    await h.drain();
    expect(h.deploys).toHaveLength(0);
    await h.reconciler.decideApproval(deploy.id, "approved", APPROVER);
    await h.drain();
    expect(h.deploys).toHaveLength(1);
  });
});
