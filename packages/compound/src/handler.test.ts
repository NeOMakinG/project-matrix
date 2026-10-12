import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryStore,
  type PhaseContext,
  type PreparedWorkspace,
  type Runner,
  type RunRequest,
  reviewReceipt,
  type Workspace,
  type WorkspaceTarget,
} from "@matrix/core";
import { expect, test } from "vitest";
import { createCompoundHandler } from "./handler.js";
import { LessonStore } from "./lesson-store.js";
import { matchFindings, runnerExecutor } from "./runner-executor.js";
import { sampleCases } from "./sample.js";
import { cases } from "./testkit.test-helpers.js";
import type { Candidate } from "./types.js";

test("compound handler proposes candidates but never promotes", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "matrix-compound-"));
  const store = new MemoryStore();
  const at = new Date(1);
  await store.createRun({
    id: "r1",
    projectId: "p1",
    ticketId: "T-1",
    phase: "review",
    attempt: 1,
    stepKey: "k",
    host: "h",
    ownerId: "o",
    status: "ok",
    startedAt: at,
    lastEventAt: at,
    heartbeatAt: at,
  });
  await store.addReceipts("r1", [
    reviewReceipt("performance", "gpt", [{ severity: "P2", title: "N+1 query in invoice list" }]),
  ]);
  const events: string[] = [];
  const ctx = {
    project: { id: "p1", repoPath },
    ticket: { id: "T-1" },
    emit: (m: string) => events.push(m),
  } as unknown as PhaseContext;
  const outcome = await createCompoundHandler({ store })(ctx);
  expect(outcome.ok).toBe(true);
  const candidates = await new LessonStore(repoPath).list();
  expect(candidates.map((c) => c.status)).toEqual(["proposed"]);
  expect(events[0]).toContain("1 candidates");
});

class RecordingWorkspace implements Workspace {
  readonly kind = "native" as const;
  prepared: WorkspaceTarget[] = [];
  cleaned: string[] = [];
  async prepare(target: WorkspaceTarget): Promise<PreparedWorkspace> {
    this.prepared.push(target);
    return { workdir: `/wt/${this.prepared.length}`, ref: target.branch };
  }
  async cleanup(p: PreparedWorkspace) {
    this.cleaned.push(p.workdir);
  }
}

test("B3: every replay run gets its own read-only worktree, cleaned up afterwards", async () => {
  const requests: RunRequest[] = [];
  const runner: Runner = {
    id: "codex",
    async run(req) {
      requests.push(req);
      const found = req.prompt.includes("idempotency")
        ? [
            {
              severity: "P1",
              title: "Retry creates duplicate checkout sessions without idempotency key",
            },
          ]
        : [];
      return {
        runId: req.runId,
        status: "ok",
        summary: JSON.stringify({ findings: found }),
        receipts: [],
        costUsd: 0.02,
      };
    },
  };
  const workspace = new RecordingWorkspace();
  const exec = runnerExecutor({
    runner,
    runnerId: "codex",
    model: "m",
    projectId: "p1",
    workspace,
    repoPath: "/repo",
    baseBranch: "main",
  });
  const replay = {
    id: "c1",
    ticketId: "T-1",
    phase: "review" as const,
    input: "review this diff",
    expectedP1: ["duplicate checkout sessions on retry"],
  };
  const candidate = {
    id: "checklist-item-0123456789ab",
    payload: {
      kind: "checklist-item",
      phase: "review",
      item: "Check idempotency keys on retried payment calls",
    },
  } as unknown as Candidate;
  expect((await exec.execute(replay, null)).p1Caught).toBe(0);
  expect((await exec.execute(replay, candidate)).p1Caught).toBe(1);
  expect(requests.map((r) => r.readOnly)).toEqual([true, true]);
  expect(new Set(requests.map((r) => r.workdir)).size).toBe(2);
  expect(new Set(workspace.prepared.map((t) => t.branch)).size).toBe(2);
  expect(workspace.cleaned).toEqual(["/wt/1", "/wt/2"]);
});

test("B3: the worktree is cleaned up even when the runner throws", async () => {
  const workspace = new RecordingWorkspace();
  const runner: Runner = {
    id: "codex",
    async run() {
      throw new Error("boom");
    },
  };
  const exec = runnerExecutor({
    runner,
    runnerId: "codex",
    model: "m",
    projectId: "p1",
    workspace,
    repoPath: "/repo",
    baseBranch: "main",
  });
  await expect(exec.execute(cases(1)[0]!, null)).rejects.toThrow("boom");
  expect(workspace.cleaned).toEqual(["/wt/1"]);
});

test("sampleCases is stratified, deterministic, deduplicated and excludes evidence tickets", () => {
  const history = [
    ...cases(5),
    {
      id: "zz-dup",
      ticketId: "T-9",
      phase: "review" as const,
      input: "review diff 0",
      expectedP1: ["bug"],
    },
    { id: "spike-1", ticketId: "S-1", phase: "spike" as const, input: "plan a", expectedP1: [] },
    { id: "spike-2", ticketId: "S-2", phase: "spike" as const, input: "plan b", expectedP1: [] },
  ];
  const opts = { perPhase: 2, seed: "s1", excludeTickets: ["H-review-4"] };
  const a = sampleCases(history, opts);
  expect(a).toEqual(sampleCases([...history].reverse(), opts));
  expect(a.filter((c) => c.phase === "review")).toHaveLength(2);
  expect(a.filter((c) => c.phase === "spike")).toHaveLength(2);
  expect(a.some((c) => c.id === "zz-dup" || c.ticketId === "H-review-4")).toBe(false);
  const variants = new Set(
    ["s1", "s2", "s3", "s4", "s5", "s6"].map((seed) =>
      sampleCases(history, { ...opts, seed })
        .map((c) => c.id)
        .join(","),
    ),
  );
  expect(variants.size).toBeGreaterThan(1);
});

test("matchFindings is one-to-one and counts false positives", () => {
  const expected = ["duplicate checkout session on retry", "missing auth check on invoice export"];
  const one = ["checkout session duplicate on retry and missing auth check on invoice export"];
  expect(matchFindings(expected, one, 0.2)).toEqual({ caught: 1, falsePositives: 0 });
  const spam = [
    "duplicate checkout session on retry",
    "x",
    "y",
    "missing auth check on invoice export",
  ];
  expect(matchFindings(expected, spam, 0.34)).toEqual({ caught: 2, falsePositives: 2 });
});
