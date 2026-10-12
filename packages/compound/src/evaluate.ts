import { createHash } from "node:crypto";
import type { Candidate, Evaluation, Metrics } from "./types.js";

/** One past ticket phase to replay, e.g. a review prompt with the P1 findings humans later confirmed. */
export interface ReplayCase {
  id: string;
  ticketId: string;
  phase: string;
  input: string;
  expectedP1: string[];
}

/** Runs a case with or without a candidate applied and measures the outcome. Must be deterministic for a given input. */
export interface ReplayExecutor {
  execute(replay: ReplayCase, candidate: Candidate | null): Promise<Metrics>;
}

export interface EvalPolicy {
  minSamples: number;
  minGain: number;
  maxRegression: number;
  weights: { p1: number; holdout: number; loopback: number; cost: number };
}

export const DEFAULT_POLICY: EvalPolicy = {
  minSamples: 3,
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

function sum(list: Metrics[]): Metrics {
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

export function decide(
  baseline: Metrics,
  candidate: Metrics,
  samples: number,
  policy: EvalPolicy = DEFAULT_POLICY,
): {
  decision: Evaluation["decision"];
  reason: string;
  baselineScore: number;
  candidateScore: number;
} {
  const baselineScore = score(baseline, samples, policy);
  const candidateScore = score(candidate, samples, policy);
  const delta = candidateScore - baselineScore;
  const recall = (m: Metrics) => (m.p1Expected > 0 ? m.p1Caught / m.p1Expected : 1);
  const result = (decision: Evaluation["decision"], reason: string) => ({
    decision,
    reason,
    baselineScore,
    candidateScore,
  });
  if (samples < policy.minSamples) {
    return result("shadow", `only ${samples} samples, need ${policy.minSamples}`);
  }
  if (recall(candidate) + policy.maxRegression < recall(baseline)) {
    return result("reject", "P1 recall regressed");
  }
  if (candidate.holdoutSatisfaction + policy.maxRegression < baseline.holdoutSatisfaction) {
    return result("reject", "holdout satisfaction regressed");
  }
  if (delta >= policy.minGain) return result("promote", `score +${delta.toFixed(3)}`);
  if (delta <= -policy.minGain) return result("reject", `score ${delta.toFixed(3)}`);
  return result("shadow", `inconclusive (${delta >= 0 ? "+" : ""}${delta.toFixed(3)})`);
}

/** Replays every case with and without the candidate, sequentially in case-id order for determinism. */
export async function evaluateCandidate(
  candidate: Candidate,
  cases: ReplayCase[],
  executor: ReplayExecutor,
  opts: { policy?: EvalPolicy; now?: () => Date } = {},
): Promise<Evaluation> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const ordered = [...cases].sort((a, b) => a.id.localeCompare(b.id));
  const results: Evaluation["cases"] = [];
  for (const replay of ordered) {
    const baseline = await executor.execute(replay, null);
    const withCandidate = await executor.execute(replay, candidate);
    results.push({ caseId: replay.id, baseline, candidate: withCandidate });
  }
  const baseline = sum(results.map((r) => r.baseline));
  const withCandidate = sum(results.map((r) => r.candidate));
  const verdict = decide(baseline, withCandidate, results.length, policy);
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const id = `eval-${createHash("sha256")
    .update(JSON.stringify([candidate.id, candidate.version, ordered.map((c) => c.id), at]))
    .digest("hex")
    .slice(0, 10)}`;
  return {
    id,
    at,
    candidateVersion: candidate.version,
    samples: results.length,
    baseline,
    candidate: withCandidate,
    baselineScore: verdict.baselineScore,
    candidateScore: verdict.candidateScore,
    delta: verdict.candidateScore - verdict.baselineScore,
    decision: verdict.decision,
    reason: verdict.reason,
    cases: results,
  };
}
