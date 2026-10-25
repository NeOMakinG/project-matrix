import { expect, test } from "vitest";
import type { AgentQaOutcome, AgentQaReport, AgentQaRequest } from "./agent-qa.js";
import type { PullRequestRequest } from "./ports-internal.js";
import { APPROVER, createHarness } from "./testing/harness.js";

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

function agentHarness(outcomes: AgentQaOutcome[], handles = true, prLabelFails = 0) {
  const published: PullRequestRequest[] = [];
  const requests: AgentQaRequest[] = [];
  const prLabels: { add: string[]; remove: string[] }[] = [];
  let merged = false;
  const h = createHarness({
    project: {
      autonomy: { default: "autonomous" },
      lastPhase: "merge",
      qa: { surfaces: ["android"], driver: "agent" },
      maxLoops: 3,
    },
    pullRequests: {
      publish: async (request) => {
        published.push(request);
        return { url: PR_URL, branch: "matrix-T-1-export" };
      },
      label: async (_project, _url, add, remove) => {
        if (prLabelFails-- > 0) throw new Error("gh pr edit failed");
        prLabels.push({ add, remove });
      },
    },
    agentQa: {
      handles: () => handles,
      run: async (request) => {
        requests.push(request);
        return outcomes.shift() ?? { kind: "blocked", reason: "no outcome scripted" };
      },
    },
    merge: {
      merge: async () =>
        merged
          ? { ok: true, summary: "merged on GitHub" }
          : { ok: false, pending: true, summary: "draft PR not merged yet" },
    },
  });
  (h.tickets as unknown as { uploadFile: unknown }).uploadFile = async (
    _id: string,
    name: string,
  ) => `https://uploads.linear.app/x/${name}`;
  return { h, published, requests, prLabels, setMerged: () => (merged = true) };
}

async function addTicket(h: ReturnType<typeof createHarness>) {
  const t = h.tickets.add("Trip PDF export");
  h.tickets.tickets.set(t.id, { ...t, body: BODY });
  return t;
}

const reports = (h: ReturnType<typeof createHarness>) =>
  h.tickets.comments.filter((c) => c.body.startsWith("Matrix agent QA")).map((c) => c.body);

test("PASS: report with screenshots, qa:passed, merge still waits for a human", async () => {
  const { h, requests, prLabels, setMerged } = agentHarness([reportOutcome(report())]);
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.pullRequest).toEqual({ url: PR_URL, number: 9, repo: "acme/wayline" });
  expect(requests[0]?.criteria).toEqual(["Export button on the trip screen"]);
  expect(JSON.stringify(requests)).not.toContain("they sign up");
  const [body] = reports(h);
  expect(body).toMatch(/^Matrix agent QA PASS for [a-f0-9]{12}/);
  expect(body).toContain("![s1.png](https://uploads.linear.app/x/s1.png)");
  expect(body).toContain("Seeker, Android 16");
  const labels = h.tickets.tickets.get(t.id)?.labels ?? [];
  expect(labels).toContain("qa:passed");
  expect(labels).not.toContain("needs-human");
  expect(prLabels).toEqual([{ add: ["qa:passed"], remove: ["qa:failed"] }]);
  // No human handoff comment in agent mode.
  expect(h.tickets.comments.some((c) => c.body.startsWith("Matrix needs a human"))).toBe(false);
  expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({
    phase: "merge",
    status: "waiting_approval",
  });
  // Not re-run on later ticks.
  await h.drain();
  expect(requests).toHaveLength(1);
  setMerged();
  const approval = await h.store.getPendingApproval("pilot", t.id, "merge");
  await h.reconciler.decideApproval(approval!.id, "approved", APPROVER);
  await h.drain();
  expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("done");
});

test("FAIL: qa:failed on ticket and PR, loops back to implement with the report", async () => {
  const fail = report({
    verdict: "FAIL",
    steps: [
      { action: "Tap Export", expected: "sheet", actual: "nothing", ok: false, criterion: 1 },
    ],
    findings: [{ severity: "P1", title: "Export dead tap", steps: "", expected: "", actual: "" }],
  });
  const { h, requests, prLabels } = agentHarness([reportOutcome(fail), reportOutcome(report())]);
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  expect(requests).toHaveLength(2);
  expect(prLabels[0]).toEqual({ add: ["qa:failed"], remove: ["qa:passed"] });
  const implement = h.implementer.calls.filter((c) => c.phase === "implement");
  expect(implement.length).toBe(2);
  expect(implement.at(-1)?.prompt).toContain("agent QA failed");
  const w = await h.store.getWorkflow("pilot", t.id);
  expect(w).toMatchObject({ phase: "merge", status: "waiting_approval", loops: 1 });
  expect(reports(h).map((b) => b.split(" ")[3])).toEqual(["FAIL", "PASS"]);
  expect(h.tickets.tickets.get(t.id)?.labels).toContain("qa:passed");
  expect(h.tickets.tickets.get(t.id)?.labels).not.toContain("qa:failed");
});

test("FAIL until the loop cap: blocked with needs-human", async () => {
  const fail = () =>
    reportOutcome(
      report({
        verdict: "FAIL",
        steps: [{ action: "Tap", expected: "a", actual: "b", ok: false, criterion: 1 }],
      }),
    );
  const { h } = agentHarness([fail(), fail(), fail(), fail(), fail()]);
  await h.setup();
  const t = await addTicket(h);
  await h.drain(200);
  const w = await h.store.getWorkflow("pilot", t.id);
  expect(w?.status).toBe("blocked");
  expect(h.tickets.tickets.get(t.id)?.labels).toContain("needs-human");
});

test("BLOCKED: needs-human with the reason, never a pass; re-runs once the label is removed", async () => {
  const { h, requests } = agentHarness([
    { kind: "blocked", reason: "device lane busy" },
    reportOutcome(report()),
  ]);
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  expect(reports(h)[0]).toContain("device lane busy");
  expect(h.tickets.tickets.get(t.id)?.labels).toContain("needs-human");
  expect(h.tickets.tickets.get(t.id)?.labels).not.toContain("qa:passed");
  await h.drain();
  expect(requests).toHaveLength(1);
  await h.tickets.removeLabel(t.id, "needs-human");
  await h.drain();
  expect(requests).toHaveLength(2);
  expect(h.tickets.tickets.get(t.id)?.labels).toContain("qa:passed");
});

test("no lane for the project: BLOCKED, not a silent pass", async () => {
  const { h, requests } = agentHarness([], false);
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  expect(requests).toHaveLength(0);
  expect(reports(h)[0]).toContain("no agent QA lane is configured");
  expect(h.tickets.tickets.get(t.id)?.labels).toContain("needs-human");
});

test("PASS claimed with a failed step is treated as FAIL", async () => {
  const lying = report({
    steps: [{ action: "Tap", expected: "a", actual: "b", ok: false, criterion: 1 }],
  });
  const { h } = agentHarness([reportOutcome(lying), reportOutcome(report())]);
  await h.setup();
  await addTicket(h);
  await h.drain();
  expect(reports(h)[0]).toMatch(/^Matrix agent QA FAIL/);
});

test("lane with nothing to report: BLOCKED with its reason", async () => {
  const { h } = agentHarness([]);
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  expect(reports(h)[0]).toContain("BLOCKED");
  expect(h.tickets.tickets.get(t.id)?.labels).toContain("needs-human");
});

test("report comment fails: nothing applied, the post is retried without re-running QA", async () => {
  const fail = report({
    verdict: "FAIL",
    steps: [{ action: "Tap", expected: "a", actual: "b", ok: false, criterion: 1 }],
  });
  const { h, requests } = agentHarness([reportOutcome(fail), reportOutcome(report())]);
  const original = h.tickets.comment.bind(h.tickets);
  let broken = true;
  h.tickets.comment = async (id: string, body: string) => {
    if (broken && body.startsWith("Matrix agent QA")) throw new Error("linear down");
    return original(id, body);
  };
  await h.setup();
  const t = await addTicket(h);
  await h.drain();
  expect(requests).toHaveLength(1);
  expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({ phase: "merge", loops: 0 });
  expect(h.tickets.tickets.get(t.id)?.labels).not.toContain("qa:failed");
  broken = false;
  await h.drain();
  expect(requests).toHaveLength(2);
  expect(reports(h)[0]).toMatch(/^Matrix agent QA FAIL/);
  expect((await h.store.getWorkflow("pilot", t.id))?.loops).toBe(1);
});

test("a failed label write after FAIL is retried; a stale qa:passed never stays", async () => {
  const fail = report({
    verdict: "FAIL",
    steps: [{ action: "Tap", expected: "a", actual: "b", ok: false, criterion: 1 }],
  });
  const { h } = agentHarness([reportOutcome(fail)]);
  await h.setup();
  const t = await addTicket(h);
  await h.tickets.addLabel(t.id, "qa:passed");
  const add = h.tickets.addLabel.bind(h.tickets);
  let failures = 2;
  h.tickets.addLabel = async (id: string, label: string) => {
    if (label === "qa:failed" && failures-- > 0) throw new Error("linear down");
    return add(id, label);
  };
  await h.drain();
  const labels = h.tickets.tickets.get(t.id)?.labels ?? [];
  expect(failures).toBeLessThan(0);
  expect(labels).toContain("qa:failed");
  expect(labels).not.toContain("qa:passed");
});

test("no acceptance criteria: BLOCKED before any device time, never a pass", async () => {
  const { h, requests } = agentHarness([reportOutcome(report())]);
  await h.setup();
  const t = h.tickets.add("Trip PDF export");
  h.tickets.tickets.set(t.id, { ...t, body: "Export a trip as PDF.\nQA: Surface: android" });
  await h.drain();
  expect(requests).toHaveLength(0);
  expect(reports(h)[0]).toMatch(/^Matrix agent QA BLOCKED/);
  expect(reports(h)[0]).toContain("no acceptance criteria");
  expect(h.tickets.tickets.get(t.id)?.labels).toContain("needs-human");
});

test("a human handoff from before the agent driver runs through the lane once needs-human is removed", async () => {
  const { h, requests } = agentHarness([reportOutcome(report())]);
  await h.setup();
  await h.store.upsertProject({ ...h.project, qa: { surfaces: ["android"], driver: "manual" } });
  const t = await addTicket(h);
  await h.drain();
  expect(h.tickets.comments.some((c) => c.body.startsWith("Matrix needs a human"))).toBe(true);
  expect(requests).toHaveLength(0);
  await h.store.upsertProject({ ...h.project, qa: { surfaces: ["android"], driver: "agent" } });
  await h.drain();
  // needs-human from the handoff still says "a human tests this".
  expect(requests).toHaveLength(0);
  await h.tickets.removeLabel(t.id, "needs-human");
  await h.drain();
  expect(requests).toHaveLength(1);
  expect(reports(h)[0]).toMatch(/^Matrix agent QA PASS/);
  expect(h.tickets.tickets.get(t.id)?.labels).toContain("qa:passed");
  expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({
    phase: "merge",
    status: "waiting_approval",
  });
});

test("a PR-label retry never rewrites ticket labels that landed (needs-human removal sticks)", async () => {
  const { h, requests, prLabels } = agentHarness(
    [{ kind: "blocked", reason: "device lane busy" }],
    true,
    3,
  );
  await h.setup();
  const t = await addTicket(h);
  const add = h.tickets.addLabel.bind(h.tickets);
  let needsHuman = 0;
  h.tickets.addLabel = async (id: string, label: string) => {
    if (label === "needs-human") needsHuman++;
    return add(id, label);
  };
  for (let i = 0; i < 5; i++) await h.drain();
  expect(needsHuman).toBe(1);
  expect(prLabels).toEqual([{ add: [], remove: ["qa:passed"] }]);
  expect(requests).toHaveLength(1);
});
