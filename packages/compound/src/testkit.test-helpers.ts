import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@matrix/core";
import type { ReplayCase, ReplayExecutor } from "./evaluate.js";
import { evaluateCandidate } from "./evaluate.js";
import { FileEvalLedger } from "./ledger.js";
import { LessonStore } from "./lesson-store.js";
import { proposeCandidates } from "./propose.js";
import { selectCases } from "./select.js";
import type { Candidate, Metrics, RawLesson } from "./types.js";

export const fixedNow = () => new Date("2026-10-12T10:00:00Z");
export const at = (hhmm: string) => () => new Date(`2026-10-12T${hhmm}:00Z`);

export const metrics = (p1Caught: number, holdout: number, cost = 0.1, fp = 0): Metrics => ({
  loopbacks: 0,
  p1Caught,
  p1Expected: 1,
  p1FalsePositives: fp,
  holdoutSatisfaction: holdout,
  costUsd: cost,
});

export const cases = (n = 3, phase: ReplayCase["phase"] = "review"): ReplayCase[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${phase}-case-${i}`,
    ticketId: `H-${phase}-${i}`,
    phase,
    input: `${phase} diff ${i}`,
    expectedP1: ["bug"],
  }));

export const executor = (gain: boolean, id = "fake"): ReplayExecutor => ({
  id,
  async execute(_replay, candidate) {
    return candidate && gain ? metrics(1, 0.95, 0.12) : metrics(0, 0.7, 0.1);
  },
});

export async function setup(lesson?: Partial<RawLesson>, history: ReplayCase[] = cases(3)) {
  const repo = await mkdtemp(join(tmpdir(), "matrix-repo-"));
  const host = await mkdtemp(join(tmpdir(), "matrix-host-"));
  const index = new MemoryStore();
  const lessons = new LessonStore(repo, index, fixedNow);
  const key = randomBytes(32);
  const ledger = await FileEvalLedger.open(join(host, "ledger"), [repo], key);
  await ledger.recordCaseHistory("p1", history);
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
  return { repo, host, index, lessons, ledger, candidate, key };
}

/** Evaluates on the authoritative case set and records the verdict in the ledger. */
export async function evaluateAndRecord(
  ctx: { ledger: FileEvalLedger; candidate: Candidate },
  exec: ReplayExecutor,
  now = fixedNow,
) {
  const selected = await selectCases(ctx.ledger, ctx.candidate);
  const evaluation = await evaluateCandidate(ctx.candidate, selected, exec, { now });
  await ctx.ledger.recordEvaluation(evaluation);
  return evaluation;
}
