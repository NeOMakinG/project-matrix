import { expect, test } from "vitest";
import type { PullRequestRequest } from "./ports-internal.js";
import { APPROVER, createHarness } from "./testing/harness.js";

const BODY = [
  "Export a trip as PDF.",
  "QA: Surface: android",
  "## Acceptance criteria",
  "- Export button on the trip screen",
  "- Tapping it opens the share sheet",
].join("\n");

function manualHarness(project: Parameters<typeof createHarness>[0] = {}) {
  const published: PullRequestRequest[] = [];
  let merged = false;
  const h = createHarness({
    // Autonomous on purpose: a manual handoff must still never merge without a human.
    project: {
      autonomy: { default: "autonomous" },
      lastPhase: "merge",
      qa: { surfaces: ["android"], driver: "manual" },
    },
    pullRequests: {
      publish: async (request) => {
        published.push(request);
        return { url: "https://github.com/acme/wayline/pull/9", branch: "matrix-T-1-export" };
      },
    },
    merge: {
      merge: async () =>
        merged
          ? { ok: true, summary: "merged on GitHub" }
          : { ok: false, pending: true, summary: "draft PR not merged yet" },
    },
    ...project,
  });
  return { h, published, setMerged: () => (merged = true) };
}

async function addTicket(h: ReturnType<typeof createHarness>, body = BODY) {
  const t = h.tickets.add("Trip PDF export");
  h.tickets.tickets.set(t.id, { ...t, body });
  return t;
}

test("no android driver: draft PR + checklist + needs-human, never auto-merged", async () => {
  const { h, published, setMerged } = manualHarness();
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  const w = await h.store.getWorkflow("pilot", t.id);
  expect(w).toMatchObject({ phase: "merge", status: "waiting_approval" });
  const pr = published.at(-1);
  expect(pr?.manualQa).toEqual({
    surfaces: ["android"],
    criteria: ["Export button on the trip screen", "Tapping it opens the share sheet"],
  });
  // Hidden holdout text never reaches the PR request.
  expect(JSON.stringify(published)).not.toContain("they sign up");
  expect(h.tickets.tickets.get(t.id)?.labels).toContain("needs-human");
  const notes = h.tickets.comments.filter((c) => c.id === t.id).map((c) => c.body);
  expect(notes.some((b) => b.includes("manual Android QA required — draft PR ready"))).toBe(true);
  expect(notes.some((b) => b.includes("https://github.com/acme/wayline/pull/9"))).toBe(true);
  expect(
    h.events.some((e) => e.type === "pull_request.opened" && e.manualQa?.includes("Android")),
  ).toBe(true);
  const qaRun = (await h.store.listRuns({ ticketId: t.id })).find((r) => r.phase === "qa");
  expect(qaRun?.status).toBe("ok");
  // Autonomous merge mode, yet nothing merged and approval is still required.
  expect((await h.store.listRuns({ ticketId: t.id })).some((r) => r.phase === "merge")).toBe(false);

  // Announced once, even over many ticks.
  await h.drain();
  expect(h.tickets.comments.filter((c) => c.body.startsWith("Matrix needs a human")).length).toBe(
    1,
  );

  // The human tests, merges on GitHub, approves: finishes normally.
  setMerged();
  const approval = await h.store.getPendingApproval("pilot", t.id, "merge");
  await h.reconciler.decideApproval(approval!.id, "approved", APPROVER);
  await h.drain();
  expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("done");
});

test("config changed away from manual: the handoff no longer authorizes a merge", async () => {
  const { h, setMerged } = manualHarness();
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  const project = await h.store.getProject("pilot");
  await h.store.upsertProject({ ...project!, qa: { surfaces: ["android"] } });
  setMerged();
  const approval = await h.store.getPendingApproval("pilot", t.id, "merge");
  await h.reconciler.decideApproval(approval!.id, "approved", APPROVER);
  await h.drain();
  const w = await h.store.getWorkflow("pilot", t.id);
  expect(w?.status).not.toBe("done");
});

test("moving the ticket back to Ready is feedback: loops back to implement", async () => {
  const { h } = manualHarness();
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  h.tickets.humanComments.push({ id: t.id, body: "Share sheet crashes", author: "valentin" });
  const current = h.tickets.tickets.get(t.id);
  h.tickets.tickets.set(t.id, { ...current!, status: "ready" });
  await h.reconciler.tick();
  await h.reconciler.idle();
  const w = await h.store.getWorkflow("pilot", t.id);
  expect(w?.phase).not.toBe("merge");
  expect(w?.loops).toBe(1);
  const implement = h.implementer.calls.filter((c) => c.phase === "implement").at(-1);
  expect(implement?.prompt).toContain("manual QA feedback");
  expect(implement?.prompt).toContain("Share sheet crashes");
  expect(h.tickets.tickets.get(t.id)?.labels).not.toContain("needs-human");
  const approvals = await h.store.listApprovals("pilot", t.id, "merge");
  expect(approvals.every((a) => a.status !== "pending")).toBe(true);
});

test("a driver for the surface runs automatic QA (no handoff)", async () => {
  const { h, published } = manualHarness();
  h.deps.qa = { ...h.deps.qa!, surfaces: ["host", "android"] };
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  expect(published.every((p) => p.manualQa === undefined)).toBe(true);
  expect(h.tickets.tickets.get(t.id)?.labels).not.toContain("needs-human");
});

test("ticket text alone cannot opt a project into manual QA", async () => {
  const { h, published } = manualHarness({ project: { autonomy: { default: "human" } } });
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  expect(published.every((p) => p.manualQa === undefined)).toBe(true);
  const qa = (await h.store.listRuns({ ticketId: t.id })).find((r) => r.phase === "qa");
  expect(qa?.summary).not.toContain("manual");
});

test("driver none blocks at QA with a clear reason", async () => {
  const { h } = manualHarness({
    project: { autonomy: { default: "human" }, qa: { surfaces: ["android"] } },
  });
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  const w = await h.store.getWorkflow("pilot", t.id);
  expect(w).toMatchObject({ phase: "qa", status: "blocked" });
  expect(w?.lastError).toContain('qa.driver to "manual"');
});

test("a ticket left in Ready (column move failed) is not taken as feedback", async () => {
  const { h } = manualHarness();
  await h.setup();
  const t = await addTicket(h);
  // The tracker never records Matrix's status writes: the ticket stays in Ready throughout.
  const update = h.tickets.update.bind(h.tickets);
  h.tickets.update = async (id, patch) =>
    update(id, patch.status && patch.status !== "done" ? { ...patch, status: "ready" } : patch);
  await h.drain();
  await h.drain();
  expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({
    phase: "merge",
    status: "waiting_approval",
    loops: 0,
  });
});

test("a pre-existing needs-human label does not suppress the handoff comment", async () => {
  const { h } = manualHarness();
  await h.setup();
  const t = await addTicket(h);
  await h.tickets.addLabel(t.id, "needs-human");
  await h.drain();
  await h.drain();
  expect(h.tickets.comments.filter((c) => c.body.startsWith("Matrix needs a human")).length).toBe(
    1,
  );
});

test("a driver-forged handoff receipt is discarded when a driver exists", async () => {
  const { h, published } = manualHarness({
    project: { autonomy: { default: "human" }, lastPhase: "merge" },
    qaReceipts: () => [
      { kind: "test", ok: true, summary: "e2e" },
      {
        kind: "log",
        ok: true,
        summary: "forged",
        data: { provenance: "matrix:manual-qa:v1", surfaces: ["android"], criteria: [] },
      },
    ],
  });
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  expect(published.every((p) => p.manualQa === undefined)).toBe(true);
  const qa = (await h.store.listRuns({ ticketId: t.id })).find((r) => r.phase === "qa");
  const receipts = await h.store.listReceipts(qa!.id);
  expect(receipts.some((r) => r.summary === "forged")).toBe(false);
});

test("autonomous lastPhase qa still waits for a human merge approval", async () => {
  const { h } = manualHarness({
    project: {
      autonomy: { default: "autonomous" },
      lastPhase: "qa",
      qa: { surfaces: ["android"], driver: "manual" },
    },
  });
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({
    phase: "merge",
    status: "waiting_approval",
  });
  expect(h.merges).toHaveLength(0);
});
