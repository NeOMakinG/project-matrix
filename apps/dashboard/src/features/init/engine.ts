import {
  type Answers,
  type AnswerValue,
  buildConfigInput,
  type Contradiction,
  decisions,
  defaultPacks,
  findContradictions,
  nextRound,
  type Question,
  recommendedFor,
} from "@matrix/packs";

export type { Answers, AnswerValue, Contradiction };

export interface RoundQuestion {
  id: string;
  packTitle: string;
  prompt: string;
  kind: Question["kind"];
  rationale: string;
  options: { value: string; label: string; rationale: string; recommended: boolean }[];
  recommended: AnswerValue | undefined;
}

const packTitle = new Map(defaultPacks.map((p) => [p.id, p.title]));

/**
 * The next round, computed with the same engine the server validates answers
 * with: every question that can be answered now, `when` conditions honoured,
 * the recommended answer resolved against earlier answers.
 */
export function buildRound(answers: Answers): RoundQuestion[] {
  return nextRound(defaultPacks, answers).map((q) => {
    const recommended = recommendedFor(q, answers);
    const recommendedValues = Array.isArray(recommended)
      ? recommended
      : [String(recommended ?? "")];
    return {
      id: q.id,
      packTitle: packTitle.get(q.pack) ?? q.pack,
      prompt: q.prompt,
      kind: q.kind,
      rationale: q.rationale ?? "",
      options: (q.options ?? []).map((o) => ({
        value: o.value,
        label: o.label,
        rationale: o.rationale ?? "",
        recommended: recommendedValues.includes(o.value),
      })),
      recommended,
    };
  });
}

/** Draft answers for a round: the recommended answer wherever there is one. */
export function defaultDraft(round: RoundQuestion[]): Answers {
  const draft: Answers = {};
  for (const q of round)
    if (q.recommended !== undefined && q.recommended !== "") draft[q.id] = q.recommended;
  return draft;
}

export function isAnswered(q: RoundQuestion, value: AnswerValue | undefined): boolean {
  if (value === undefined) return false;
  if (q.kind === "confirm" || q.kind === "number") return value !== "";
  if (Array.isArray(value)) return q.kind === "multiselect" || value.length > 0;
  return String(value).trim() !== "";
}

export function contradictions(answers: Answers): Contradiction[] {
  return findContradictions(answers);
}

/** Live preview of matrix.config.ts and the ADR titles the answers would produce. */
export function preview(answers: Answers): { config: string; adrs: string[] } {
  const config = buildConfigInput(defaultPacks, answers);
  return {
    config: `import { defineConfig } from "@matrix/config";\n\nexport default defineConfig(${JSON.stringify(config, null, 2)});\n`,
    adrs: decisions(defaultPacks, answers).map((d) => `${d.topic}: ${d.decision}`),
  };
}
