import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Receipt } from "./ports.js";

export interface HoldoutScenario {
  id: string;
  given: string;
  when: string;
  then: string;
}

export interface ScenarioVerdict {
  id: string;
  satisfied: boolean;
  reason: string;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export const QA_JUDGE_CRITERIA =
  "Every assertion in the full then clause must be demonstrated by host-executed evidence. Inspect probe source and actual output; exit zero, printed claims, simulations, or checking only part of the clause are insufficient. Absence claims require instrumentation installed before importing/exercising the software, covering the named surfaces (e.g. fs, net, console), and assertions of zero intercepted calls. A nonzero host exit cannot satisfy a scenario.";

const NEGATED_VERB =
  "(?:produce|perform|write|log|mutate|modify|access|emit|call|send|upload|save|store|fetch|request|delete|change|show|display|render|appear)\\w*";
const ABSENCE = new RegExp(
  [
    "\\b(?:no|without|never|absence|unchanged|unmodified)\\b",
    "\\bzero\\s+(?:[\\w./:-]+\\s+){0,4}(?:calls|writes|requests|effects)\\b",
    "\\b(?:pure|purity)\\b",
    `\\b(?:not|cannot|\\w+n't)\\s+(?:be(?:en)?\\s+|get\\s+)?${NEGATED_VERB}\\b`,
    "\\b(?:not|\\w+n't)\\s+(?:be(?:en)?\\s+|get\\s+)?\\w+(?:ed|en)\\b",
  ].join("|"),
  "i",
);

/** Quoted strings are displayed copy, not claims: `shows "No photos yet"` asserts presence. */
const QUOTED = /"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`|(?<![\w])'[^']*'(?![\w])/g;

/**
 * Words that introduce displayed content. Everything after them in the same clause is the
 * content being asserted present (an empty-state message may itself contain "no").
 */
const DISPLAY =
  /\b(?:show(?:s|n|ing)?|display(?:s|ed|ing)?|render(?:s|ed|ing)?|read(?:s|ing)|say(?:s|ing)|message|text|copy|label(?:led)?|title(?:d)?|heading|caption|placeholder|banner|toast|empty[- ]state)\b/i;

/** Clause boundaries: sentence ends, semicolons, commas, and coordinating conjunctions. */
const CLAUSE = /[.;,!?]+(?=\s|$)|[;\n]|\b(?:and|but|while|whereas|then)\b/i;

/**
 * True when `text` claims something does NOT happen or is absent (needs instrumentation).
 * Assertions that a message is displayed are presence claims even when the copy is negative.
 */
export function hasAbsenceClaim(text: string): boolean {
  return text
    .replace(QUOTED, " ")
    .split(CLAUSE)
    .some((clause) => {
      const match = ABSENCE.exec(clause);
      if (!match) return false;
      const display = clause.search(DISPLAY);
      // A negation inside the displayed content (after the display word) is copy, not a claim.
      return display === -1 || match.index < display;
    });
}

export function validateScenario(scenario: HoldoutScenario): void {
  if (
    ![scenario.given, scenario.when, scenario.then].every(
      (text) => typeof text === "string" && text.trim(),
    )
  )
    throw new Error("invalid scenario fields");
  if (
    /^(?:it )?(?:works(?: correctly)?|behaves correctly|is correct|is good|is fast|is secure)[.!]?$/i.test(
      scenario.then.trim(),
    )
  )
    throw new Error("scenario must specify observable assertions");
  if (
    hasAbsenceClaim(scenario.then) &&
    (!/\b(?:stub|spy|mock|instrument|intercept|snapshot|capture)\w*\b/i.test(
      `${scenario.given} ${scenario.then}`,
    ) ||
      !/\b(?:assert|verify|check|expect)\w*\b/i.test(scenario.then))
  )
    throw new Error("absence claim requires an instrumentable assertion");
  if (
    /\b(?:no|without)\s+(?:observable\s+)?I\/O\b/i.test(scenario.then) &&
    !["fs", "net", "console"].every((surface) =>
      new RegExp(`\\b${surface}\\b`, "i").test(`${scenario.given} ${scenario.then}`),
    )
  )
    throw new Error("I/O absence must name instrumented surfaces");
}

const SECRET_SHAPES: RegExp[] = [
  /\b(authorization|cookie|x-api-key)(\s*[:=]\s*)[^\n]*/gi,
  /\b[Bb]earer\s+[^\s"',;]+/g,
  /\b(?:sk|mxr|ghp|gho|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{6,}/g,
  /\b(api[_-]?key|token|secret|password|authorization|cookie)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
  /[A-Za-z0-9+_-]{32,}={0,2}/g,
];

/**
 * Operator-facing cause of a private QA failure: single line, secret-shaped values masked,
 * bounded. Parse errors are never echoed (they can quote model output, i.e. holdout text).
 */
export function privateQaCause(error: unknown, max = 300): string {
  if (error instanceof SyntaxError) return "model output was not valid JSON";
  const raw = error instanceof Error ? error.message : "non-Error failure";
  let text = raw
    .slice(0, max * 4)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .trim();
  for (const shape of SECRET_SHAPES)
    text = text.replace(shape, (match, name?: string, sep?: string) =>
      typeof name === "string" && typeof sep === "string"
        ? `${name}${sep}[REDACTED]`
        : "[REDACTED]",
    );
  return text.length > max ? `${text.slice(0, max)}…` : text || "unknown failure";
}

/** Fixed-wording reasons a scenario batch is rejected; anything else is reported generically. */
const SCENARIO_REJECTIONS: RegExp[] = [
  /^scenario model run (?:failed|timeout|cancelled)$/,
  /^no JSON found in model output$/,
  /^unterminated JSON in model output$/,
  /^scenarios must be an array$/,
  /^invalid scenario count$/,
  /^scenario \d{1,2} is missing given\/when\/then$/,
  /^invalid scenario fields$/,
  /^scenario must specify observable assertions$/,
  /^absence claim requires an instrumentable assertion$/,
  /^I\/O absence must name instrumented surfaces$/,
  /^duplicate scenario ids$/,
];

/**
 * Why a private scenario batch was rejected, safe to log: only the validator's own fixed messages
 * pass through (they never quote holdout text); JSON errors and anything else stay generic.
 */
export function scenarioRejectionReason(error: unknown): string {
  if (error instanceof SyntaxError) return "model output was not valid JSON";
  const message = error instanceof Error ? error.message : "";
  // The runner failure, already redacted by callModel for the private path.
  if (message.startsWith("Private QA model unavailable (")) return privateQaCause(error);
  return SCENARIO_REJECTIONS.some((shape) => shape.test(message))
    ? message
    : "unrecognized validation failure";
}

export async function retryPrivateQa<T>(
  signal: AbortSignal,
  operation: (attempt: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === 1) throw error;
    }
  }
}

/** Only holdout receipts produced by core's own judge carry this tag; drivers' receipts are dropped. */
export const HOLDOUT_PROVENANCE = "core-judge";

export function isTrustedHoldout(receipt: Receipt): boolean {
  return (
    receipt.kind === "holdout" &&
    (receipt.data as { provenance?: string } | undefined)?.provenance === HOLDOUT_PROVENANCE
  );
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error("no JSON found in model output");
  const open = candidate[start];
  const close = open === "[" ? "]" : "}";
  const end = candidate.lastIndexOf(close);
  if (end <= start) throw new Error("unterminated JSON in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

/** A batch may lose invalid scenarios and still be used when at least this many remain. */
export const MIN_SCENARIOS_AFTER_DROP = 3;

export interface ScenarioBatch {
  scenarios: HoldoutScenario[];
  /** Fixed validator reasons for scenarios dropped from the batch (never holdout text). */
  dropped: string[];
}

/**
 * Parses a scenario batch, dropping individually invalid scenarios instead of rejecting the
 * whole batch, as long as MIN_SCENARIOS_AFTER_DROP valid ones remain. A batch with nothing
 * dropped keeps any non-empty size. Otherwise the first validation error is thrown.
 */
export function parseScenarioBatch(text: string): ScenarioBatch {
  const value = extractJson(text);
  const list = Array.isArray(value) ? value : (value as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(list)) throw new Error("scenarios must be an array");
  if (!list.length || list.length > 16) throw new Error("invalid scenario count");
  const scenarios: HoldoutScenario[] = [];
  const dropped: string[] = [];
  let firstError: unknown;
  list.forEach((raw, i) => {
    const s = raw as Partial<HoldoutScenario>;
    if (!s.given || !s.when || !s.then) throw new Error(`scenario ${i} is missing given/when/then`);
    const scenario = {
      id: s.id && SAFE_ID.test(s.id) ? s.id : `s${i + 1}`,
      given: s.given,
      when: s.when,
      then: s.then,
    };
    try {
      validateScenario(scenario);
      scenarios.push(scenario);
    } catch (error) {
      firstError ??= error;
      dropped.push(scenarioRejectionReason(error));
    }
  });
  if (dropped.length && scenarios.length < MIN_SCENARIOS_AFTER_DROP) throw firstError;
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length)
    throw new Error("duplicate scenario ids");
  return { scenarios, dropped };
}

export function parseScenarios(text: string): HoldoutScenario[] {
  return parseScenarioBatch(text).scenarios;
}

export function parseVerdicts(text: string): ScenarioVerdict[] {
  const value = extractJson(text);
  const list = Array.isArray(value) ? value : (value as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(list)) throw new Error("verdicts must be an array");
  return list.map((raw) => {
    const v = raw as Partial<ScenarioVerdict>;
    if (typeof v.id !== "string" || typeof v.satisfied !== "boolean")
      throw new Error("invalid verdict");
    return { id: v.id, satisfied: v.satisfied, reason: v.reason ?? "" };
  });
}

export function holdoutReceipt(
  scenarios: HoldoutScenario[],
  verdicts: ScenarioVerdict[],
  judgeModel: string,
): Receipt {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const satisfied = scenarios.filter((s) => byId.get(s.id)?.satisfied === true).length;
  const satisfaction = scenarios.length ? satisfied / scenarios.length : 0;
  return {
    kind: "holdout",
    ok: scenarios.length > 0,
    summary: `${satisfied}/${scenarios.length} holdout scenarios satisfied (judge ${judgeModel})`,
    data: {
      provenance: HOLDOUT_PROVENANCE,
      satisfaction,
      satisfied,
      total: scenarios.length,
      judgeModel,
      verdicts: scenarios.map((scenario, scenarioIndex) => ({
        scenarioIndex,
        satisfied: byId.get(scenario.id)?.satisfied === true,
      })),
    },
  };
}

/** Scenarios live outside every worktree so the implementing agent can never read or edit them. */
export class HoldoutStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private file(projectId: string, ticketId: string): string {
    if (!SAFE_ID.test(projectId) || !SAFE_ID.test(ticketId)) {
      throw new Error("unsafe project or ticket id for holdout path");
    }
    return join(this.root, projectId, `${ticketId}.json`);
  }

  /** True when `path` is the store root or below it ("/data/holdouts-evil" is not inside "/data/holdouts"). */
  isInside(path: string): boolean {
    const rel = relative(this.root, resolve(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  /** Refuses to operate when the store would sit inside a worktree the implementer can read. */
  assertOutside(workdir: string): void {
    const rel = relative(resolve(workdir), this.root);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new Error("holdout store must live outside the worktree");
    }
  }

  async save(projectId: string, ticketId: string, scenarios: HoldoutScenario[]): Promise<void> {
    const file = this.file(projectId, ticketId);
    await mkdir(join(this.root, projectId), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(scenarios, null, 2), { mode: 0o600 });
  }

  async load(projectId: string, ticketId: string): Promise<HoldoutScenario[]> {
    try {
      return JSON.parse(
        await readFile(this.file(projectId, ticketId), "utf8"),
      ) as HoldoutScenario[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
