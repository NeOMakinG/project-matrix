import { extractJson } from "./holdout.js";
import type { Receipt } from "./ports.js";
import type { PhaseModel, ProjectConfig, ReviewFinding, ReviewLane, Severity } from "./types.js";

const LANE_FOCUS: Record<ReviewLane, string> = {
  "correctness-security":
    "bugs, edge cases, error handling, injection, authn/authz, secrets, data loss, concurrency",
  "architecture-adr":
    "violations of the ADRs in docs/adr, module boundaries, layering, duplication, naming against CONTEXT.md",
  "ux-product":
    "behaviour against the ticket and product goals, UX states (loading, empty, error), copy, accessibility",
  performance: "queries, N+1, bundle size, rendering cost, memory, unnecessary work in hot paths",
};

const SEVERITIES: ReadonlySet<Severity> = new Set(["P1", "P2", "P3"]);

/** Reviewers must use a different model than the implementer. */
export function pickReviewer(
  config: ProjectConfig,
  implementerModel: string | undefined,
): PhaseModel {
  // Exclude both the model that actually implemented and the configured implementer model,
  // so an unknown implementer can never silently be reviewed by itself.
  const excluded = new Set([config.models.implement.model, implementerModel].filter(Boolean));
  const candidates = [config.models.review, ...config.reviewerFallbacks];
  const pick = candidates.find((c) => !excluded.has(c.model));
  if (!pick) {
    throw new Error(`no reviewer model differs from the implementer (${[...excluded].join(", ")})`);
  }
  return pick;
}

export function lanePrompt(
  lane: ReviewLane,
  ticketTitle: string,
  ticketBody: string,
  baseBranch: string,
): string {
  return [
    `You are the ${lane} reviewer for this change. Review only; do not edit files.`,
    `Ticket: ${ticketTitle}`,
    ticketBody,
    `Inspect the diff against ${baseBranch} (git diff ${baseBranch}...HEAD).`,
    `Focus: ${LANE_FOCUS[lane]}.`,
    "Severity: P1 = must fix before merge (bug, security issue, ADR violation, broken requirement); P2 = should fix; P3 = nit.",
    'Reply with JSON only: {"findings":[{"severity":"P1|P2|P3","title":"...","file":"path:line","detail":"..."}]}',
    'Use {"findings":[]} when there is nothing to report.',
  ].join("\n\n");
}

export function parseFindings(text: string): ReviewFinding[] {
  const value = extractJson(text) as { findings?: unknown };
  if (!Array.isArray(value.findings)) throw new Error("review output has no findings array");
  return value.findings.map((raw, i) => {
    const f = raw as Partial<ReviewFinding>;
    if (!f.severity || !SEVERITIES.has(f.severity) || !f.title) {
      throw new Error(`finding ${i} is missing a valid severity or title`);
    }
    return {
      severity: f.severity,
      title: f.title,
      ...(f.file ? { file: f.file } : {}),
      ...(f.detail ? { detail: f.detail } : {}),
    };
  });
}

export function reviewReceipt(lane: ReviewLane, model: string, findings: ReviewFinding[]): Receipt {
  const counts = { P1: 0, P2: 0, P3: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return {
    kind: "review",
    ok: counts.P1 === 0,
    summary: `${lane} (${model}): P1 ${counts.P1} · P2 ${counts.P2} · P3 ${counts.P3}`,
    data: { lane, model, findings },
  };
}
