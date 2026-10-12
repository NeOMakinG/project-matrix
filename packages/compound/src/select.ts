import { DEFAULT_POLICY, type EvalPolicy, type ReplayCase } from "./evaluate.js";
import { candidateHash } from "./hash.js";
import type { EvalLedger } from "./ledger.js";
import { sampleCases } from "./sample.js";
import type { Candidate } from "./types.js";

/**
 * The only case set an evaluation of `candidate` may use: drawn from the host-owned history in the
 * ledger, seeded by the candidate's patch hash, excluding the tickets its evidence came from. The
 * caller does not choose history, seed or exclusions.
 */
export async function selectCases(
  ledger: EvalLedger,
  candidate: Candidate,
  policy: EvalPolicy = DEFAULT_POLICY,
): Promise<ReplayCase[]> {
  const history = await ledger.caseHistory(candidate.projectId);
  return sampleCases(history, {
    perPhase: policy.perPhase,
    max: policy.maxCases,
    seed: candidateHash(candidate),
    excludeTickets: [...new Set(candidate.evidence.map((e) => e.ticketId))],
  });
}
