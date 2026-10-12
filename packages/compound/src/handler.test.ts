import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type PhaseContext, type Runner, reviewReceipt } from "@matrix/core";
import { expect, test } from "vitest";
import { createCompoundHandler } from "./handler.js";
import { LessonStore } from "./lesson-store.js";
import { runnerExecutor } from "./runner-executor.js";
import type { Candidate } from "./types.js";

test("compound handler proposes candidates but never promotes", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "matrix-compound-"));
  const store = new MemoryStore();
  await store.createRun({
    id: "r1",
    projectId: "p1",
    ticketId: "T-1",
    phase: "review",
    attempt: 1,
    stepKey: "k",
    host: "h",
    status: "ok",
    startedAt: new Date(1),
    lastEventAt: new Date(1),
  });
  await store.addReceipts("r1", [
    reviewReceipt("performance", "gpt", [{ severity: "P2", title: "N+1 query in invoice list" }]),
  ]);
  const handler = createCompoundHandler({ store });
  const events: string[] = [];
  const ctx = {
    project: { id: "p1", repoPath },
    ticket: { id: "T-1" },
    emit: (m: string) => events.push(m),
  } as unknown as PhaseContext;
  const outcome = await handler(ctx);
  expect(outcome.ok).toBe(true);
  const candidates = await new LessonStore(repoPath).list();
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.status).toBe("proposed");
  expect(events[0]).toContain("1 candidates");
});

test("runner executor scores P1 recall with and without the candidate", async () => {
  const runner: Runner = {
    id: "codex",
    async run(req) {
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
  const exec = runnerExecutor({
    runner,
    runnerId: "codex",
    model: "m",
    workdir: "/tmp",
    projectId: "p1",
  });
  const replay = {
    id: "c1",
    ticketId: "T-1",
    phase: "review",
    input: "review this diff",
    expectedP1: ["duplicate checkout sessions on retry"],
  };
  const candidate = {
    id: "x",
    payload: {
      kind: "checklist-item",
      phase: "review",
      item: "Check idempotency keys on retried payment calls",
    },
  } as unknown as Candidate;
  expect((await exec.execute(replay, null)).p1Caught).toBe(0);
  expect((await exec.execute(replay, candidate)).p1Caught).toBe(1);
});
