import type { Phase } from "@matrix/core";
import { candidateHash, canonical, caseSetHash, sha256 } from "./hash.js";
import type { Candidate, Evaluation, Metrics } from "./types.js";

/** Bump when scoring or execution semantics change: older evaluations then stop counting for promotion. */
export const HARNESS_VERSION = "replay-v2";
/** Hard floor on replayed cases; a policy can ask for more, never fewer. */
export const MIN_CASES = 3;

/** One past ticket phase to replay, e.g. a review prompt with the P1 findings humans later confirmed. */
export interface ReplayCase {
  id: string;
  ticketId: string;
  phase: Phase;
  input: string;
  expectedP1: string[];
}

/** Runs a case with or without a candidate applied and measures it. Must be deterministic for a given input. */
export interface ReplayExecutor {
  readonly id: string;
  execute(replay: ReplayCase, candidate: Candidate | null): Promise<Metrics>;
}

export interface EvalPolicy {
  minSamples: number;
  minGain: number;
  maxRegression: number;
  weights: { p1: number; holdout: number; loopback: number; cost: number };
}

export const DEFAULT_POLICY: EvalPolicy = {
  minSamples: MIN_CASES,
  minGain: 0.05,
  maxRegression: 0.02,
  weights: { p1: 0.5, holdout: 0.4, loopback: 0.15, cost: 0.05 },
};

const ZERO: Metrics = {
  loopbacks: 0,
  p1Caught: 0,
  p1Expected: 0,
  holdoutSatisfaction: 0,
  costUsd: 0,
};

export function sumMetrics(list: Metrics[]): Metrics {
  if (!list.length) return { ...ZERO };
  const total = list.reduce(
    (acc, m) => ({
      loopbacks: acc.loopbacks + m.loopbacks,
      p1Caught: acc.p1Caught + m.p1Caught,
      p1Expected: acc.p1Expected + m.p1Expected,
      holdoutSatisfaction: acc.holdoutSatisfaction + m.holdoutSatisfaction,
      costUsd: acc.costUsd + m.costUsd,
    }),
    { ...ZERO },
  );
  return { ...total, holdoutSatisfaction: total.holdoutSatisfaction / list.length };
}

export function score(m: Metrics, samples: number, policy: EvalPolicy = DEFAULT_POLICY): number {
  const n = Math.max(samples, 1);
  const recall = m.p1Expected > 0 ? m.p1Caught / m.p1Expected : 1;
  const w = policy.weights;
  return (
    w.p1 * recall +
    w.holdout * m.holdoutSatisfaction -
    w.loopback * (m.loopbacks / n) -
    w.cost * (m.costUsd / n)
  );
}

export interface CaseResult {
  caseId: string;
  baseline: Metrics;
  candidate: Metrics;
}

/** Aggregate gain is required, and no single case may get worse than `maxRegression`. */
export function decide(
  cases: CaseResult[],
  policy: EvalPolicy = DEFAULT_POLICY,
): {
  decision: Evaluation["decision"];
  reason: string;
  baselineScore: number;
  candidateScore: number;
} {
  const n = cases.length;
  const baseline = sumMetrics(cases.map((c) => c.baseline));
  const candidate = sumMetrics(cases.map((c) => c.candidate));
  const baselineScore = score(baseline, n, policy);
  const candidateScore = score(candidate, n, policy);
  const delta = candidateScore - baselineScore;
  const result = (decision: Evaluation["decision"], reason: string) => ({
    decision,
    reason,
    baselineScore,
    candidateScore,
  });
  const required = Math.max(MIN_CASES, policy.minSamples);
  if (n < required) return result("shadow", `only ${n} cases, need ${required}`);
  const regressed = cases.filter(
    (c) => score(c.candidate, 1, policy) + policy.maxRegression < score(c.baseline, 1, policy),
  );
  if (regressed.length)
    return result("reject", `regressed on ${regressed.map((c) => c.caseId).join(", ")}`);
  if (delta >= policy.minGain)
    return result("promote", `score +${delta.toFixed(3)} across ${n} cases`);
  if (delta <= -policy.minGain) return result("reject", `score ${delta.toFixed(3)}`);
  return result("shadow", `inconclusive (${delta >= 0 ? "+" : ""}${delta.toFixed(3)})`);
}

/** Replays every case with and without the candidate, sequentially in case-id order. Duplicate case ids are refused. */
export async function evaluateCandidate(
  candidate: Candidate,
  cases: ReplayCase[],
  executor: ReplayExecutor,
  opts: { policy?: EvalPolicy; now?: () => Date } = {},
): Promise<Evaluation> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const ordered = [...cases].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(ordered.map((c) => c.id)).size !== ordered.length)
    throw new Error("duplicate replay case ids");
  const results: Evaluation["cases"] = [];
  for (const replay of ordered) {
    const baseline = await executor.execute(replay, null);
    const withCandidate = await executor.execute(replay, candidate);
    const baselineScore = score(baseline, 1, policy);
    const candidateScore = score(withCandidate, 1, policy);
    results.push({
      caseId: replay.id,
      phase: replay.phase,
      baseline,
      candidate: withCandidate,
      baselineScore,
      candidateScore,
      delta: candidateScore - baselineScore,
    });
  }
  const verdict = decide(results, policy);
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const cHash = candidateHash(candidate);
  const sHash = caseSetHash(ordered);
  return {
    id: `eval-${sha256(canonical([cHash, sHash, HARNESS_VERSION, executor.id, at])).slice(0, 16)}`,
    at,
    candidateId: candidate.id,
    candidateHash: cHash,
    caseSetHash: sHash,
    harnessVersion: HARNESS_VERSION,
    executorId: executor.id,
    samples: results.length,
    baseline: sumMetrics(results.map((r) => r.baseline)),
    candidate: sumMetrics(results.map((r) => r.candidate)),
    baselineScore: verdict.baselineScore,
    candidateScore: verdict.candidateScore,
    delta: verdict.candidateScore - verdict.baselineScore,
    decision: verdict.decision,
    reason: verdict.reason,
    cases: results,
  };
}
