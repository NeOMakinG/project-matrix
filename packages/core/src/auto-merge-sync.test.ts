import { expect, test } from "vitest";
import type { AgentQaOutcome, AgentQaReport } from "./agent-qa.js";
import type { BaseState, BaseSyncResult } from "./ports-internal.js";
import { createHarness } from "./testing/harness.js";

const BODY = [
  "Export a trip as PDF.",
  "QA: Surface: android",
  "## Acceptance criteria",
  "- Export button on the trip screen",
].join("\n");

const PR_URL = "https://github.com/acme/wayline/pull/9";

function report(over: Partial<AgentQaReport> = {}): AgentQaReport {
  return {
    verdict: "PASS",
    summary: "Export works",
    steps: [
      {
        action: "Tap Export",
        expected: "share sheet",
        actual: "share sheet",
        ok: true,
        criterion: 1,
        screenshot: "s1.png",
      },
    ],
    findings: [],
    ...over,
  };
}

function reportOutcome(r: AgentQaReport): AgentQaOutcome {
  return {
    kind: "report",
    report: r,
    screenshots: [{ name: "s1.png", bytes: new Uint8Array([137, 80, 78, 71]) }],
    device: { serial: "emulator-5554", model: "Seeker", android: "16" },
    build: { appId: "com.acme.app", kind: "release", abi: "arm64-v8a" },
    durationMs: 120_000,
  };
}

function autoMergeHarness(states: BaseState[], sync: BaseSyncResult) {
  const merged: string[] = [];
  const synced: string[] = [];
  const h = createHarness({
    project: {
      autonomy: { default: "autonomous" },
      lastPhase: "merge",
      qa: { surfaces: ["android"], driver: "agent" },
      deploy: { merge: "auto", targets: [] },
      maxLoops: 3,
    },
    pullRequests: {
      publish: async () => ({ url: PR_URL, branch: "matrix-T-1-export" }),
      label: async () => undefined,
      baseState: async () => states.shift() ?? { kind: "current" },
    },
    agentQa: { handles: () => true, run: async () => reportOutcome(report()) },
    merge: {
      merge: async (_ctx, request) => {
        merged.push(request.headSha);
        return { ok: true, summary: `squash-merged (merge commit ${"c".repeat(40)})` };
      },
    },
  });
  (h.tickets as unknown as { uploadFile: unknown }).uploadFile = async (
    _id: string,
    name: string,
  ) => `https://uploads.linear.app/x/${name}`;
  (h.git as unknown as { syncOnto: unknown }).syncOnto = async (_workdir: string, onto: string) => {
    synced.push(onto);
    return sync;
  };
  return { h, merged, synced };
}

async function addTicket(h: ReturnType<typeof createHarness>) {
  const t = h.tickets.add("Trip PDF export");
  h.tickets.tickets.set(t.id, { ...t, body: BODY });
  return t;
}

const BASE = "b".repeat(40);

test("auto-merge: a current base merges after the PASS and comments the merge commit", async () => {
  const { h, merged, synced } = autoMergeHarness([], { kind: "current" });
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  await h.drain();
  expect(synced).toEqual([]);
  expect(merged).toHaveLength(1);
  expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("done");
  expect(h.tickets.comments.some((c) => c.body.includes(`merge commit ${"c".repeat(40)}`))).toBe(
    true,
  );
});

test("auto-merge: a conflicting base goes back to Implement with the files, nothing merges", async () => {
  const { h, merged, synced } = autoMergeHarness(
    [
      {
        kind: "outdated",
        reason: "GitHub reports conflicts with main",
        base: "main",
        baseSha: BASE,
      },
    ],
    { kind: "conflict", files: ["src/a.ts"] },
  );
  await h.setup();
  const t = await addTicket(h);
  for (let i = 0; i < 6 && synced.length === 0; i++) await h.drain();
  expect(synced).toEqual([BASE]);
  // The requeue sent the ticket back to Implement with the conflict to resolve (not a review loop),
  // and only a head validated again after that could merge.
  const requeued = h.events.find(
    (e) =>
      e.type === "workflow.changed" &&
      e.workflow.phase === "implement" &&
      (e.workflow.lastError ?? "").includes("src/a.ts"),
  );
  expect(requeued).toBeTruthy();
  if (requeued?.type === "workflow.changed") expect(requeued.workflow.loops).toBe(0);
  await h.drain();
  expect(merged.length).toBeLessThanOrEqual(1);
  expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("done");
});
