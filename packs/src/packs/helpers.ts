import type { Answers, AnswerValue, Option } from "../types";

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

export const hasGoBackend = (a: Answers): boolean => is(a, "backend.kind", "go");

/** Any server we own (TypeScript or Go). */
/** Server code we own: a TypeScript or Go API, or a full-stack framework's server side. */
export const hasServer = (a: Answers): boolean =>
  hasBackend(a) || hasGoBackend(a) || is(a, "backend.kind", "fullstack");

export const hasMobile = (a: Answers): boolean =>
  includes(a, "platforms.targets", "ios") || includes(a, "platforms.targets", "android");

export const usesExpo = (a: Answers): boolean => hasMobile(a) && is(a, "mobile.framework", "expo");

export const hasDesktop = (a: Answers): boolean => includes(a, "platforms.targets", "desktop");

export const usesTauri = (a: Answers): boolean =>
  hasDesktop(a) && is(a, "desktop.framework", "tauri");

/** Full-stack React frameworks own their server side (routes, server functions). */
export const usesFullStackReact = (a: Answers): boolean =>
  usesReact(a) &&
  (is(a, "frontend.bundler", "next") || is(a, "frontend.bundler", "tanstack-start"));
