import type { components } from "@matrix/sdk";
import { z } from "zod";
import type { InitProgress } from "@/api/view";

export type AnswerValue = string | number | boolean | string[];
export type Answers = Record<string, AnswerValue>;
export type Contradiction = components["schemas"]["Contradiction"];
export type RoundQuestion = InitProgress["round"][number];

export const roundQuestionSchema: z.ZodType<RoundQuestion> = z.object({
  id: z.string(),
  pack: z.string(),
  kind: z.enum(["select", "multiselect", "text", "list", "confirm", "number"]),
  prompt: z.string(),
  rationale: z.string(),
  recommended: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  options: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      recommended: z.boolean(),
    }),
  ),
  dependsOn: z.array(z.string()),
});

export function isAnswerValue(value: unknown): value is AnswerValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

export function defaultDraft(round: RoundQuestion[]): Answers {
  const draft: Answers = {};
  for (const question of round)
    if (question.recommended !== null && question.recommended !== "")
      draft[question.id] = question.recommended;
  return draft;
}

export function submittedValue(question: RoundQuestion, value: AnswerValue): AnswerValue {
  return question.kind === "list" && typeof value === "string"
    ? value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : value;
}

export function isAnswered(question: RoundQuestion, value: AnswerValue | undefined): boolean {
  if (value === undefined) return false;
  if (question.kind === "confirm") return typeof value === "boolean";
  if (question.kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (Array.isArray(value)) return question.kind === "multiselect" || value.length > 0;
  return String(value).trim() !== "";
}
