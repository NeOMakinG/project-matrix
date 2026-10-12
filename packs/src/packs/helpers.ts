import type { AnswerValue, Answers, Option } from "../types";

export const opt = (value: string, label: string, rationale?: string): Option =>
  rationale === undefined ? { value, label } : { value, label, rationale };

export const list = (value: AnswerValue): string[] =>
  Array.isArray(value)
    ? value
    : String(value)
        .split(/[;,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);

export const includes = (answers: Answers, id: string, value: string): boolean => {
  const v = answers[id];
  return Array.isArray(v) ? v.includes(value) : v === value;
};

export const is = (answers: Answers, id: string, value: AnswerValue): boolean =>
  answers[id] === value;

export const hasWebUi = (a: Answers): boolean =>
  includes(a, "platforms.targets", "web") || includes(a, "platforms.targets", "desktop");

export const usesReact = (a: Answers): boolean =>
  hasWebUi(a) && is(a, "frontend.framework", "react");

export const hasBackend = (a: Answers): boolean => is(a, "backend.kind", "node-api");
