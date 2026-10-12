import {
  type Answers,
  type AnswerValue,
  allQuestions,
  buildConfigInput,
  decisions,
  defaultPacks,
  isActive,
  nextRound,
  type Pack,
  type Question,
  recommendedFor,
} from "@matrix/packs";
import { HttpError } from "./auth/guard.js";

export type Tone = "green" | "blue" | "amber" | "red" | "violet" | "neutral";

export interface InitProgress {
  packs: {
    id: string;
    label: string;
    answered: number;
    total: number;
    state: "done" | "active" | "todo";
  }[];
  answered: { questionId: string; label: string; value: string }[];
  question: {
    id: string;
    pack: string;
    index: number;
    total: number;
    context: string;
    prompt: string;
    rationale: string;
    facts: string;
    options: { id: string; label: string; description: string; recommended: boolean }[];
  } | null;
  configPreview: string;
  adrs: { id: string; title: string; status: { label: string; tone: Tone } }[];
}

const isAnswerValue = (v: unknown): v is AnswerValue =>
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean" ||
  (Array.isArray(v) && v.every((x) => typeof x === "string"));

/** Keeps only well-typed answers to known questions. */
export function toAnswers(raw: Record<string, unknown>, packs: Pack[] = defaultPacks): Answers {
  const known = new Set(allQuestions(packs).map((q) => q.id));
  const out: Answers = {};
  for (const [id, value] of Object.entries(raw)) {
    if (known.has(id) && isAnswerValue(value)) out[id] = value;
  }
  return out;
}

/** Rejects answers to unknown questions or with the wrong shape, instead of storing junk. */
export function validateAnswers(raw: Record<string, unknown>, packs: Pack[] = defaultPacks): void {
  const index = new Map(allQuestions(packs).map((q) => [q.id, q]));
  for (const [id, value] of Object.entries(raw)) {
    const question = index.get(id);
    if (!question) throw new HttpError(400, "invalid_request", `unknown question ${id}`);
    if (!isAnswerValue(value))
      throw new HttpError(400, "invalid_request", `invalid answer for ${id}`);
    const options = question.options?.map((o) => o.value);
    if (options && question.kind === "select" && !options.includes(String(value))) {
      throw new HttpError(400, "invalid_request", `${id} must be one of ${options.join(", ")}`);
    }
    if (options && question.kind === "multiselect") {
      const values = Array.isArray(value) ? value : [String(value)];
      const unknown = values.filter((v) => !options.includes(v));
      if (unknown.length > 0)
        throw new HttpError(400, "invalid_request", `${id}: unknown ${unknown.join(", ")}`);
    }
  }
}

const display = (q: Question, value: AnswerValue): string => {
  const values = Array.isArray(value) ? value : [String(value)];
  const labels = values.map((v) => q.options?.find((o) => o.value === v)?.label ?? v);
  return labels.join(", ");
};

/** Interview state for the dashboard: pack progress, the current question and live previews. */
export function initProgress(
  rawAnswers: Record<string, unknown>,
  packs: Pack[] = defaultPacks,
): InitProgress {
  const answers = toAnswers(rawAnswers, packs);
  const current = nextRound(packs, answers)[0] ?? null;

  const packRows = packs.map((pack) => {
    const active = pack.questions.filter((q) => isActive(q, answers));
    const answered = active.filter((q) => q.id in answers).length;
    const state: "done" | "active" | "todo" =
      current?.pack === pack.id ? "active" : answered === active.length ? "done" : "todo";
    return { id: pack.id, label: pack.title, answered, total: active.length, state };
  });

  const questions = allQuestions(packs);
  const answered = questions
    .filter((q) => q.id in answers && isActive(q, answers))
    .map((q) => ({
      questionId: q.id,
      label: q.prompt,
      value: display(q, answers[q.id] as AnswerValue),
    }));

  let question: InitProgress["question"] = null;
  if (current) {
    const pack = packs.find((p) => p.id === current.pack);
    const activeInPack = pack?.questions.filter((q) => isActive(q, answers)) ?? [];
    const recommended = recommendedFor(current, answers);
    const recommendedValues = Array.isArray(recommended)
      ? recommended
      : [String(recommended ?? "")];
    question = {
      id: current.id,
      pack: current.pack,
      index: activeInPack.findIndex((q) => q.id === current.id) + 1,
      total: activeInPack.length,
      context: pack?.title ?? current.pack,
      prompt: current.prompt,
      rationale: current.rationale ?? "",
      facts: "",
      options: (current.options ?? []).map((o) => ({
        id: o.value,
        label: o.label,
        description: o.rationale ?? "",
        recommended: recommendedValues.includes(o.value),
      })),
    };
  }

  const config = buildConfigInput(packs, answers);
  const adrs = decisions(packs, answers).map((d, i) => ({
    id: String(i + 1).padStart(4, "0"),
    title: `${d.topic}: ${d.decision}`,
    status: { label: "proposed", tone: "blue" as const },
  }));

  return {
    packs: packRows,
    answered,
    question,
    configPreview: `import { defineConfig } from "@matrix/config";\n\nexport default defineConfig(${JSON.stringify(config, null, 2)});\n`,
    adrs,
  };
}
