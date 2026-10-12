import type { AutonomyMode } from "@matrix/core";
import { DEFAULT_POLICY, decide, type EvalPolicy, HARNESS_VERSION, MIN_CASES } from "./evaluate.js";
import { candidateHash, caseSetHash } from "./hash.js";
import type { EvalLedger, Promotion } from "./ledger.js";
import { selectCases } from "./select.js";
import type { Candidate, CandidateKind, Evaluation } from "./types.js";

export class PromotionError extends Error {}

/** The authoritative case set for a candidate right now: its hash and sorted case ids. */
export async function expectedCaseSet(
  ledger: EvalLedger,
  candidate: Candidate,
  policy: EvalPolicy = DEFAULT_POLICY,
) {
  const cases = await selectCases(ledger, candidate, policy);
  return { hash: caseSetHash(cases), ids: cases.map((c) => c.id).sort() };
}

/**
 * Re-derives the verdict from per-case metrics instead of trusting the stored decision, and checks the
 * evaluation is bound to this exact patch, the current harness, and the authoritative case set.
 */
export function verifyEvaluation(
  candidate: Candidate,
  evaluation: Evaluation,
  expected: { hash: string; ids: string[] },
  policy: EvalPolicy = DEFAULT_POLICY,
): string | null {
  if (evaluation.candidateId !== candidate.id) return "evaluation is for another candidate";
  if (evaluation.candidateHash !== candidateHash(candidate))
    return "evaluation is for a different patch";
  if (evaluation.harnessVersion !== HARNESS_VERSION)
    return `harness ${evaluation.harnessVersion} is outdated`;
  if (evaluation.caseSetHash !== expected.hash)
    return "evaluation did not use the authoritative case set";
  const ids = evaluation.cases.map((c) => c.caseId).sort();
  if (ids.length !== expected.ids.length || ids.some((id, i) => id !== expected.ids[i])) {
    return "evaluated cases differ from the authoritative case set";
  }
  const required = Math.max(MIN_CASES, policy.minSamples);
  if (evaluation.cases.length < required || evaluation.samples !== evaluation.cases.length) {
    return `needs ${required} replayed cases, has ${evaluation.cases.length}`;
  }
  const recomputed = decide(evaluation.cases, policy);
  if (recomputed.decision !== "promote")
    return `cases do not support promotion: ${recomputed.reason}`;
  if (evaluation.decision !== "promote") return `evaluation decided ${evaluation.decision}`;
  return null;
}

/** Latest evaluation of this exact patch (by time, then id). Later verdicts always supersede earlier ones. */
async function latestEvaluation(
  ledger: EvalLedger,
  candidate: Candidate,
): Promise<Evaluation | undefined> {
  const hash = candidateHash(candidate);
  return (await ledger.listEvaluations(candidate.id))
    .filter((e) => e.candidateHash === hash)
    .at(-1);
}

/**
 * Promotes the current patch only if its LATEST evaluation verifies. A newer reject or regression
 * blocks promotion even when an older run passed, so re-running until something passes does not work.
 */
export async function promote(
  candidate: Candidate,
  ledger: EvalLedger,
  opts: { policy?: EvalPolicy; now?: () => Date } = {},
): Promise<Promotion> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const latest = await latestEvaluation(ledger, candidate);
  if (!latest)
    throw new PromotionError(`${candidate.id} has no recorded evaluation for this patch`);
  const problem = verifyEvaluation(
    candidate,
    latest,
    await expectedCaseSet(ledger, candidate, policy),
    policy,
  );
  if (problem)
    throw new PromotionError(`${candidate.id} latest evaluation ${latest.id}: ${problem}`);
  const promotion: Promotion = {
    candidateId: candidate.id,
    candidateHash: candidateHash(candidate),
    evaluationId: latest.id,
    caseSetHash: latest.caseSetHash,
    harnessVersion: latest.harnessVersion,
    at: (opts.now ?? (() => new Date()))().toISOString(),
  };
  await ledger.recordPromotion(promotion);
  return promotion;
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

/**
 * Full re-check before a candidate is applied: a promotion exists for this exact patch, the latest
 * evaluation of the patch is still the promoted one (any later reject revokes it) and still verifies
 * against today's authoritative case set, and approval exists when the autonomy mode requires it.
 */
export async function assertApplicable(
  candidate: Candidate,
  ledger: EvalLedger,
  mode: AutonomyMode,
  policy: EvalPolicy = DEFAULT_POLICY,
): Promise<Promotion> {
  const hash = candidateHash(candidate);
  const promotion = await ledger.getPromotion(candidate.id, hash);
  if (!promotion) throw new PromotionError(`${candidate.id} is not promoted for this exact patch`);
  const latest = await latestEvaluation(ledger, candidate);
  if (!latest || latest.id !== promotion.evaluationId) {
    throw new PromotionError(`${candidate.id} promotion was superseded by a later evaluation`);
  }
  const problem = verifyEvaluation(
    candidate,
    latest,
    await expectedCaseSet(ledger, candidate, policy),
    policy,
  );
  if (problem) throw new PromotionError(`${candidate.id}: ${problem}`);
  if (
    requiresApproval(candidate.payload.kind, mode) &&
    !(await ledger.getApproval(candidate.id, hash))
  ) {
    throw new PromotionError(`${candidate.id} needs human approval (${mode} mode)`);
  }
  return promotion;
}
