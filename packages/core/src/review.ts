import { extractJson } from "./holdout.js";
import { resolveModel } from "./models.js";
import type { Receipt } from "./ports.js";
import {
  REVIEW_ENVIRONMENT_RULES,
  type ReviewContext,
  renderReviewContext,
} from "./review-context.js";
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
  const excluded = new Set(
    [
      config.models.implement.model,
      config.models.tiers?.large.model,
      config.models.tiers?.small.model,
      implementerModel,
    ]
      .filter((model): model is string => Boolean(model))
      .map((model) => resolveModel(config, model)),
  );
  const candidates = [config.models.review, ...config.reviewerFallbacks];
  if (implementerModel) excluded.add(implementerModel);
  const pick = candidates.find((candidate) => !excluded.has(resolveModel(config, candidate.model)));
  if (!pick) {
    throw new Error(`no reviewer model differs from the implementer (${[...excluded].join(", ")})`);
  }
  return pick;
}

export function lanePrompt(
  lane: ReviewLane,
  ticket: string,
  baseBranch: string,
  context?: ReviewContext,
): string {
  return [
    `You are the ${lane} reviewer for this change. Review only; do not edit files.`,
    ticket,
    REVIEW_ENVIRONMENT_RULES,
    context
      ? renderReviewContext(lane, context)
      : `The host could not compute the change against ${baseBranch}; review the files in the read-only workdir and add a toolingNote saying the diff was unavailable.`,
    `Focus: ${LANE_FOCUS[lane]}.`,
    "Severity: P1 = must fix before merge (bug, security issue, ADR violation, broken requirement); P2 = should fix; P3 = nit.",
    'Reply with JSON only: {"findings":[{"severity":"P1|P2|P3","title":"...","file":"path:line","detail":"..."}],"toolingNotes":["..."]}',
    'Use {"findings":[],"toolingNotes":[]} when there is nothing to report.',
  ].join("\n\n");
}

/** Model-declared tooling notes (environment limitations), bounded; never blocking. */
export function parseToolingNotes(text: string): string[] {
  const value = extractJson(text) as { toolingNotes?: unknown };
  if (!Array.isArray(value.toolingNotes)) return [];
  return value.toolingNotes
    .filter((note): note is string => typeof note === "string" && note.trim().length > 0)
    .slice(0, 20)
    .map((note) => note.trim().slice(0, 500));
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

export function reviewReceipt(
  lane: ReviewLane,
  model: string,
  findings: ReviewFinding[],
  toolingNotes: string[] = [],
): Receipt {
  const counts = { P1: 0, P2: 0, P3: 0 };
  for (const f of findings) counts[f.severity] += 1;
  const notes = toolingNotes.length ? ` · tooling notes ${toolingNotes.length}` : "";
  return {
    kind: "review",
    ok: counts.P1 === 0,
    summary: `${lane} (${model}): P1 ${counts.P1} · P2 ${counts.P2} · P3 ${counts.P3}${notes}`,
    data: { lane, model, findings, ...(toolingNotes.length ? { toolingNotes } : {}) },
  };
}
