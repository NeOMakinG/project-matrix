import type { AutonomyMode } from "@matrix/core";
import { DEFAULT_POLICY, decide, type EvalPolicy, HARNESS_VERSION, MIN_CASES } from "./evaluate.js";
import { candidateHash } from "./hash.js";
import type { EvalLedger, Promotion } from "./ledger.js";
import type { Candidate, CandidateKind, Evaluation } from "./types.js";

export class PromotionError extends Error {}

/**
 * Re-derives the verdict from the per-case metrics instead of trusting the stored decision, and checks
 * the evaluation is bound to this exact patch and the current harness.
 */
export function verifyEvaluation(
  candidate: Candidate,
  evaluation: Evaluation,
  policy: EvalPolicy = DEFAULT_POLICY,
): string | null {
  if (evaluation.candidateId !== candidate.id) return "evaluation is for another candidate";
  if (evaluation.candidateHash !== candidateHash(candidate))
    return "evaluation is for a different patch";
  if (evaluation.harnessVersion !== HARNESS_VERSION)
    return `harness ${evaluation.harnessVersion} is outdated`;
  const required = Math.max(MIN_CASES, policy.minSamples);
  if (evaluation.cases.length < required || evaluation.samples !== evaluation.cases.length) {
    return `needs ${required} replayed cases, has ${evaluation.cases.length}`;
  }
  if (new Set(evaluation.cases.map((c) => c.caseId)).size !== evaluation.cases.length)
    return "duplicate cases";
  const recomputed = decide(evaluation.cases, policy);
  if (recomputed.decision !== "promote")
    return `cases do not support promotion: ${recomputed.reason}`;
  if (evaluation.decision !== "promote") return `evaluation decided ${evaluation.decision}`;
  return null;
}

/** Promotes the current version of a candidate if the ledger holds an evaluation that verifies. */
export async function promote(
  candidate: Candidate,
  ledger: EvalLedger,
  opts: { policy?: EvalPolicy; now?: () => Date } = {},
): Promise<Promotion> {
  const hash = candidateHash(candidate);
  const evaluations = (await ledger.listEvaluations(candidate.id)).filter(
    (e) => e.candidateHash === hash,
  );
  if (!evaluations.length)
    throw new PromotionError(`${candidate.id} has no recorded evaluation for this patch`);
  const reasons: string[] = [];
  for (const evaluation of [...evaluations].reverse()) {
    const problem = verifyEvaluation(candidate, evaluation, opts.policy);
    if (problem) {
      reasons.push(`${evaluation.id}: ${problem}`);
      continue;
    }
    const promotion: Promotion = {
      candidateId: candidate.id,
      candidateHash: hash,
      evaluationId: evaluation.id,
      caseSetHash: evaluation.caseSetHash,
      harnessVersion: evaluation.harnessVersion,
      at: (opts.now ?? (() => new Date()))().toISOString(),
    };
    await ledger.recordPromotion(promotion);
    return promotion;
  }
  throw new PromotionError(`${candidate.id} cannot be promoted: ${reasons.join("; ")}`);
}

/**
 * Whether a human must approve a promoted candidate before agents consume it. Prompt and checklist
 * text steer agents directly, so only fully autonomous projects skip approval; machine-checked ADR
 * rules need approval only in human mode.
 */
export function requiresApproval(kind: CandidateKind, mode: AutonomyMode): boolean {
  if (kind === "adr-rule") return mode === "human";
  return mode !== "autonomous";
}

export async function approve(
  candidate: Candidate,
  ledger: EvalLedger,
  by: string,
  opts: { note?: string; now?: () => Date } = {},
): Promise<void> {
  const hash = candidateHash(candidate);
  if (!(await ledger.getPromotion(candidate.id, hash))) {
    throw new PromotionError(`${candidate.id} must be promoted before approval`);
  }
  await ledger.recordApproval({
    candidateId: candidate.id,
    candidateHash: hash,
    by,
    ...(opts.note ? { note: opts.note } : {}),
    at: (opts.now ?? (() => new Date()))().toISOString(),
  });
}

/** Full re-check before a candidate is applied: promotion for this exact patch, its evaluation still verifies, approval when required. */
export async function assertApplicable(
  candidate: Candidate,
  ledger: EvalLedger,
  mode: AutonomyMode,
  policy: EvalPolicy = DEFAULT_POLICY,
): Promise<Promotion> {
  const hash = candidateHash(candidate);
  const promotion = await ledger.getPromotion(candidate.id, hash);
  if (!promotion) throw new PromotionError(`${candidate.id} is not promoted for this exact patch`);
  const evaluation = await ledger.getEvaluation(candidate.id, promotion.evaluationId);
  if (!evaluation)
    throw new PromotionError(`${candidate.id} promotion references a missing evaluation`);
  const problem = verifyEvaluation(candidate, evaluation, policy);
  if (problem) throw new PromotionError(`${candidate.id}: ${problem}`);
  if (
    requiresApproval(candidate.payload.kind, mode) &&
    !(await ledger.getApproval(candidate.id, hash))
  ) {
    throw new PromotionError(`${candidate.id} needs human approval (${mode} mode)`);
  }
  return promotion;
}
