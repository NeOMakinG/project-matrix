import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@matrix/core";
import type { ReplayCase, ReplayExecutor } from "./evaluate.js";
import { FileEvalLedger } from "./ledger.js";
import { LessonStore } from "./lesson-store.js";
import { proposeCandidates } from "./propose.js";
import type { Metrics, RawLesson } from "./types.js";

export const fixedNow = () => new Date("2026-10-12T10:00:00Z");

export const metrics = (p1Caught: number, holdout: number, cost = 0.1): Metrics => ({
  loopbacks: 0,
  p1Caught,
  p1Expected: 1,
  holdoutSatisfaction: holdout,
  costUsd: cost,
});

export const cases = (n = 3): ReplayCase[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `case-${i}`,
    ticketId: `T-${i}`,
    phase: "review" as const,
    input: `review diff ${i}`,
    expectedP1: ["bug"],
  }));

export const executor = (gain: boolean, id = "fake"): ReplayExecutor => ({
  id,
  async execute(_replay, candidate) {
    return candidate && gain ? metrics(1, 0.95, 0.12) : metrics(0, 0.7, 0.1);
  },
});

export async function setup(lesson?: Partial<RawLesson>) {
  const repo = await mkdtemp(join(tmpdir(), "matrix-repo-"));
  const host = await mkdtemp(join(tmpdir(), "matrix-host-"));
  const index = new MemoryStore();
  const lessons = new LessonStore(repo, index, fixedNow);
  const ledger = new FileEvalLedger(join(host, "ledger"), [repo]);
  const raw: RawLesson = {
    projectId: "p1",
    ticketId: "T-1",
    source: "loopback",
    phase: "checks",
    text: "typecheck failed on optional props",
    ...lesson,
  };
  const [proposal] = await proposeCandidates([raw]);
  const candidate = await lessons.upsert("p1", proposal!);
  return { repo, host, index, lessons, ledger, candidate };
}
