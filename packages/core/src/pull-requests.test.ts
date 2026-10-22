import { expect, test } from "vitest";
import type { PullRequestRequest } from "./ports-internal.js";
import { APPROVER, createHarness } from "./testing/harness.js";

test("a validated run opens its draft PR before the merge approval and ends at merge", async () => {
  const published: PullRequestRequest[] = [];
  let merged = false;
  const h = createHarness({
    project: { autonomy: { default: "human" }, lastPhase: "merge" },
    pullRequests: {
      publish: async (request) => {
        published.push(request);
        return { url: "https://github.com/acme/app/pull/7", branch: "matrix-T-1-x" };
      },
    },
    merge: {
      merge: async () =>
        merged
          ? { ok: true, summary: "merged on GitHub" }
          : { ok: false, pending: true, summary: "draft PR not merged yet" },
    },
  });
  await h.setup();
  const t = h.tickets.add("Pricing page");
  await h.drain();
  let w = await h.store.getWorkflow("pilot", t.id);
  expect(w).toMatchObject({ phase: "merge", status: "waiting_approval" });
  expect(published.length).toBeGreaterThan(0);
  const first = published[0];
  expect(first?.ticket.id).toBe(t.id);
  expect(first?.headSha).toBe(await h.git.headSha(w?.workdir ?? ""));
  expect(first?.evidence.map((e) => e.phase)).toEqual(["checks", "review", "qa"]);
  expect(h.events.some((e) => e.type === "pull_request.opened")).toBe(true);
  const approvalAt = h.events.findIndex(
    (e) => e.type === "approval.requested" && e.phase === "merge",
  );
  const openedAt = h.events.findIndex((e) => e.type === "pull_request.opened");
  expect(openedAt).toBeLessThan(approvalAt);

  // Approved before the human merged on GitHub: waits again instead of blocking.
  const early = await h.store.getPendingApproval("pilot", t.id, "merge");
  await h.reconciler.decideApproval(early!.id, "approved", APPROVER);
  await h.drain();
  w = await h.store.getWorkflow("pilot", t.id);
  expect(w).toMatchObject({ phase: "merge", status: "waiting_approval" });
  // One merge attempt per human approval: no tick-rate polling.
  await h.drain();
  const mergeRuns = async () =>
    (await h.store.listRuns({ ticketId: t.id })).filter((r) => r.phase === "merge").length;
  expect(await mergeRuns()).toBe(1);

  merged = true;
  const again = await h.store.getPendingApproval("pilot", t.id, "merge");
  expect(again?.id).not.toBe(early?.id);
  await h.reconciler.decideApproval(again!.id, "approved", APPROVER);
  await h.drain();
  w = await h.store.getWorkflow("pilot", t.id);
  expect(w?.status).toBe("done");
  const phases = (await h.store.listRuns({ ticketId: t.id })).map((r) => r.phase);
  expect(phases).not.toContain("deploy");
});

test("a failing publisher never fails the workflow", async () => {
  const h = createHarness({
    project: { autonomy: { default: "human" } },
    pullRequests: {
      publish: async () => {
        throw new Error("gh: network down");
      },
    },
  });
  await h.setup();
  const t = h.tickets.add("Flaky network");
  await h.drain();
  expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({
    phase: "merge",
    status: "waiting_approval",
  });
  expect(h.events.some((e) => e.type === "tracker.failed" && e.operation === "pull-request")).toBe(
    true,
  );
});

test("a head that moved after QA is never published", async () => {
  const published: string[] = [];
  const h = createHarness({
    project: { autonomy: { default: "human" } },
    pullRequests: {
      publish: async (request) => {
        published.push(request.headSha);
        return { url: "https://github.com/acme/app/pull/8", branch: "matrix-T-1" };
      },
    },
  });
  await h.setup();
  const t = h.tickets.add("Moved head");
  await h.drain();
  const w = await h.store.getWorkflow("pilot", t.id);
  const count = published.length;
  expect(count).toBeGreaterThan(0);
  h.git.commit(w?.workdir ?? "", "f".repeat(40));
  await h.reconciler.tick();
  expect(published.length).toBe(count);
  expect(
    h.events.some((e) => e.type === "tracker.failed" && /QA-validated head/.test(e.message ?? "")),
  ).toBe(true);
});
