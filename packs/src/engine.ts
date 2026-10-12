import { type MatrixConfig, matrixConfig } from "@matrix/config";
import type { Answers, AnswerValue, InferContext, Pack, Question, RuleStub } from "./types";

export const allQuestions = (packs: Pack[]): Question[] => packs.flatMap((p) => p.questions);

const byId = (packs: Pack[]) => new Map(allQuestions(packs).map((q) => [q.id, q]));

export function isActive(q: Question, answers: Answers): boolean {
  return q.when ? q.when(answers) : true;
}

export function recommendedFor(q: Question, answers: Answers): AnswerValue | undefined {
  return typeof q.recommended === "function" ? q.recommended(answers) : q.recommended;
}

/**
 * The next interview round: every active, unanswered question whose dependencies are
 * answered (or no longer exist in this branch of the design tree).
 */
export function nextRound(packs: Pack[], answers: Answers): Question[] {
  const index = byId(packs);
  return allQuestions(packs).filter((q) => {
    if (q.id in answers || !isActive(q, answers)) return false;
    return (q.dependsOn ?? []).every((dep) => {
      const d = index.get(dep);
      return dep in answers || d === undefined || !isActive(d, answers);
    });
  });
}

export function inferAnswers(packs: Pack[], ctx: InferContext): Answers {
  const inferred: Answers = {};
  for (const q of allQuestions(packs)) {
    const v = q.infer?.(ctx);
    if (v !== undefined) inferred[q.id] = v;
  }
  return inferred;
}

export interface ResolveResult {
  answers: Answers;
  /** Questions still needing a human answer (only when recommendations are not accepted). */
  missing: Question[];
  rounds: string[][];
}

/** Walks the design tree round by round, filling gaps with recommendations when allowed. */
export function resolve(
  packs: Pack[],
  given: Answers,
  opts: { acceptRecommended: boolean },
): ResolveResult {
  const answers: Answers = { ...given };
  const rounds: string[][] = [];
  const missing: Question[] = [];
  const skipped = new Set<string>();
  for (let guard = 0; guard < 50; guard++) {
    const round = nextRound(packs, answers).filter((q) => !skipped.has(q.id));
    if (round.length === 0) break;
    rounds.push(round.map((q) => q.id));
    for (const q of round) {
      const rec = recommendedFor(q, answers);
      if (opts.acceptRecommended && rec !== undefined) answers[q.id] = rec;
      else {
        missing.push(q);
        skipped.add(q.id);
      }
    }
  }
  return { answers: activeAnswers(packs, answers), missing, rounds };
}

/** Drops answers that belong to inactive branches of the design tree. */
export function activeAnswers(packs: Pack[], answers: Answers): Answers {
  const out: Answers = {};
  for (const q of allQuestions(packs)) {
    const v = answers[q.id];
    if (v !== undefined && isActive(q, answers)) out[q.id] = v;
  }
  return out;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    node[key] ??= {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1] as string] = value;
}

export function buildConfigInput(packs: Pack[], answers: Answers): Record<string, unknown> {
  const config: Record<string, unknown> = { version: 1 };
  for (const q of allQuestions(packs)) {
    const v = answers[q.id];
    if (v === undefined || !isActive(q, answers)) continue;
    setPath(config, q.field, q.toValue ? q.toValue(v, answers) : v);
  }
  return config;
}

export type BuildResult =
  | { ok: true; config: MatrixConfig }
  | { ok: false; issues: { path: string; message: string }[] };

export function buildConfig(packs: Pack[], answers: Answers): BuildResult {
  const parsed = matrixConfig.safeParse(buildConfigInput(packs, answers));
  if (parsed.success) return { ok: true, config: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}

export interface DecisionRecord {
  questionId: string;
  topic: string;
  decision: string;
  rationale: string | undefined;
  alternatives: string[];
  context: string;
  consequences: string | undefined;
  rules: RuleStub[];
}

export function decisions(packs: Pack[], answers: Answers): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  for (const q of allQuestions(packs)) {
    const v = answers[q.id];
    if (!q.adr || v === undefined || !isActive(q, answers)) continue;
    const values = Array.isArray(v) ? v : [String(v)];
    const chosen = q.options?.filter((o) => values.includes(o.value)) ?? [];
    const label = chosen.length > 0 ? chosen.map((o) => o.label).join(", ") : values.join(", ");
    out.push({
      questionId: q.id,
      topic: q.adr.topic,
      decision: label,
      rationale: chosen[0]?.rationale ?? q.rationale,
      alternatives: (q.options ?? []).filter((o) => !values.includes(o.value)).map((o) => o.label),
      context: q.adr.context,
      consequences: q.adr.consequences,
      rules: q.adr.rules?.(v, answers) ?? [],
    });
  }
  return out;
}
