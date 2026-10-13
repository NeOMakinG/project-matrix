import {
  type Answers,
  type AnswerValue,
  activeAnswers,
  allQuestions,
  buildConfigInput,
  decisions,
  defaultPacks,
  findContradictions,
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
  answered: (RoundQuestion & { questionId: string; label: string; value: string })[];
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
  /** Every question answerable now (the current design-tree round), not only the first. */
  round: RoundQuestion[];
  contradictions: {
    id: string;
    severity: "error" | "warning";
    message: string;
    questions: string[];
  }[];
}

export interface RoundQuestion {
  id: string;
  pack: string;
  kind: Question["kind"];
  prompt: string;
  rationale: string;
  recommended: AnswerValue | null;
  options: { id: string; label: string; description: string; recommended: boolean }[];
  dependsOn: string[];
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

/**
 * Changes one answer and drops what no longer applies: answers to questions that depend on it
 * (transitively, they must be asked again) and answers whose `when` condition is now false.
 */
export function reviseAnswer(
  raw: Record<string, unknown>,
  questionId: string,
  value: unknown,
  packs: Pack[] = defaultPacks,
): { answers: Answers; dropped: string[] } {
  validateAnswers({ [questionId]: value }, packs);
  const answers = toAnswers(raw, packs);
  const questions = allQuestions(packs);
  const dependents = new Set<string>();
  let frontier = [questionId];
  while (frontier.length > 0) {
    const next = questions
      .filter((q) => !dependents.has(q.id) && q.dependsOn?.some((d) => frontier.includes(d)))
      .map((q) => q.id);
    for (const id of next) dependents.add(id);
    frontier = next;
  }
  const revised: Answers = { ...answers, [questionId]: value as AnswerValue };
  for (const id of dependents) delete revised[id];
  const kept = activeAnswers(packs, revised);
  const dropped = Object.keys(answers).filter((id) => id !== questionId && !(id in kept));
  return { answers: kept, dropped };
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

function describeQuestion(question: Question, answers: Answers): RoundQuestion {
  const recommended = recommendedFor(question, answers);
  const values =
    recommended === undefined
      ? []
      : Array.isArray(recommended)
        ? recommended
        : [String(recommended)];
  return {
    id: question.id,
    pack: question.pack,
    kind: question.kind,
    prompt: question.prompt,
    rationale: question.rationale ?? "",
    recommended: recommended ?? null,
    options: (question.options ?? []).map((option) => ({
      id: option.value,
      label: option.label,
      description: option.rationale ?? "",
      recommended: values.includes(option.value),
    })),
    dependsOn: question.dependsOn ?? [],
  };
}

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
      ...describeQuestion(q, answers),
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

  const round = nextRound(packs, answers).map((question) => describeQuestion(question, answers));

  return {
    round,
    contradictions: findContradictions(answers),
    packs: packRows,
    answered,
    question,
    configPreview: `import { defineConfig } from "@matrix/config";\n\nexport default defineConfig(${JSON.stringify(config, null, 2)});\n`,
    adrs,
  };
}
