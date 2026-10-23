import {
  type Failure,
  type Failures,
  failureKey,
  failureText,
  sanitizeFailure,
} from "./check-parsers.js";
import type { Receipt } from "./ports.js";
import type { PhaseContext } from "./ports-internal.js";
import type { BaselineMode, CheckCommand, CheckParser } from "./types.js";

/** One check command's result on the base commit (host-side, cached by the port). */
export interface BaselineRun {
  code: number;
  failures: Failures;
}

/**
 * Runs check commands on the base commit the run branch forked from (merge-base with the trusted
 * base ref, computed host-side), in a clean tree with the same setup and sandbox. A per-check
 * `error` means no usable baseline (that check then gates strictly).
 */
export interface BaselinePort {
  defaultMode(ctx: PhaseContext): BaselineMode;
  run(
    ctx: PhaseContext,
    checks: CheckCommand[],
  ): Promise<{ baseSha: string; results: (BaselineRun | { error: string })[] }>;
  /**
   * Precomputes (and caches) base results for these checks, e.g. when a ticket starts so the
   * checks phase never waits on the base run. Best effort: never throws.
   */
  warm?(ctx: PhaseContext, checks: CheckCommand[]): Promise<void>;
  /** Stores the full failure lists host-side; returns a reference for the receipt. */
  evidence?(ctx: PhaseContext, record: CheckEvidence): Promise<string | undefined>;
}

/** Full (sanitized, uncapped up to MAX_FAILURES) failure lists of one gated check. */
export interface CheckEvidence {
  kind: string;
  index: number;
  parser: CheckParser;
  mode: BaselineMode;
  baseSha?: string;
  note: string;
  newFailures: string[];
  preExisting: string[];
  flaky: string[];
}

export interface BaselineVerdict {
  mode: BaselineMode;
  parser: CheckParser;
  ok: boolean;
  baseSha?: string;
  /** Failures absent on base (sanitized, at most MAX_LISTED). */
  newFailures: string[];
  newCount: number;
  /** Failures present on base too; -1 when unknown (exit-code mode, both failing). */
  preExisting: number;
  note: string;
  /** New on this branch but passed on a retry (sanitized, at most MAX_LISTED); not failing. */
  flaky?: string[];
  /** Host-side evidence reference with the full lists. */
  evidence?: string;
}

export const MAX_LISTED = 50;

/** Multiset difference by failure key: each branch failure consumes one base failure with its key. */
export function newFailures<T extends Failure>(
  branch: readonly T[],
  base: readonly Failure[],
): T[] {
  const left = new Map<string, number>();
  for (const f of base) left.set(failureKey(f), (left.get(failureKey(f)) ?? 0) + 1);
  const fresh: T[] = [];
  for (const f of branch) {
    const n = left.get(failureKey(f)) ?? 0;
    if (n > 0) left.set(failureKey(f), n - 1);
    else fresh.push(f);
  }
  return fresh;
}

/**
 * Gate rule for a compare-mode check: fail only on failures absent on base, or when the check
 * passed on base. Anything that cannot be compared (no baseline, unparseable output) fails closed.
 */
export function compareToBase(
  parser: CheckParser,
  branch: BaselineRun,
  base: BaselineRun | { error: string } | undefined,
  baseSha?: string,
): BaselineVerdict {
  const v = (
    ok: boolean,
    fresh: readonly Failure[],
    preExisting: number,
    note: string,
    count = fresh.length,
  ): BaselineVerdict => ({
    mode: "compare",
    parser,
    ok,
    ...(baseSha ? { baseSha } : {}),
    newFailures: fresh.slice(0, MAX_LISTED).map(failureText),
    newCount: count,
    preExisting,
    note,
  });
  if (branch.code === 0) return v(true, [], 0, "passed");
  if (!base || "error" in base)
    return v(
      false,
      branch.failures ?? [],
      0,
      `no baseline (${base?.error ?? "unavailable"})`,
      Math.max(1, branch.failures?.length ?? 1),
    );
  if (base.code === 0)
    return v(
      false,
      branch.failures ?? [],
      0,
      "passed on the base commit, fails now",
      Math.max(1, branch.failures?.length ?? 1),
    );
  if (parser === "exit-code")
    return v(
      true,
      [],
      -1,
      "fails on the base commit too (exit-code only: new failures not detectable)",
    );
  if (branch.failures === null) return v(false, [], 0, "output unparseable; cannot compare", 1);
  if (base.failures === null)
    return v(false, branch.failures, 0, "base output unparseable; cannot compare");
  const fresh = newFailures(branch.failures, base.failures);
  return v(
    fresh.length === 0,
    fresh,
    branch.failures.length - fresh.length,
    fresh.length ? `${fresh.length} new vs base` : "only pre-existing failures",
  );
}

export function verdictOf(receipt: Receipt): BaselineVerdict | undefined {
  const data = receipt.data as { baseline?: unknown } | undefined;
  const b = data?.baseline as Partial<BaselineVerdict> | undefined;
  if (!b || typeof b !== "object") return undefined;
  if (typeof b.newCount !== "number" || typeof b.preExisting !== "number") return undefined;
  if (!Array.isArray(b.newFailures)) return undefined;
  const strings = (v: unknown[]) => v.filter((f): f is string => typeof f === "string");
  const newFailures = strings(b.newFailures);
  const { flaky: rawFlaky, ...rest } = b as BaselineVerdict;
  const flaky = Array.isArray(rawFlaky) ? strings(rawFlaky) : undefined;
  return { ...rest, newFailures, ...(flaky?.length ? { flaky } : {}) };
}

/**
 * First `max` new failure identities across receipts, sanitized for a tracker comment (the
 * receipts hold untrusted tool output), prefixed with the check kind.
 */
export function newFailureNames(receipts: readonly Receipt[], max = 20): string[] {
  const out: string[] = [];
  for (const r of receipts) {
    const v = verdictOf(r);
    if (!v || v.ok) continue;
    for (const f of v.newFailures) {
      if (out.length >= max) return out;
      out.push(`${sanitizeFailure(r.kind, 20)}: ${sanitizeFailure(f, 180)}`);
    }
  }
  return out;
}

const UNIT: Record<string, [string, string]> = {
  lint: ["lint error", "lint errors"],
  typecheck: ["type error", "type errors"],
  test: ["test failure", "test failures"],
};
const unit = (kind: string, n: number) => {
  const [one, many] = UNIT[kind] ?? [`${kind} failure`, `${kind} failures`];
  return n === 1 ? one : many;
};

/**
 * Loop-back reason for failed checks. Compare-mode checks list only NEW failures (sanitized,
 * bounded; untrusted tool output) and tell the implementer to leave pre-existing ones alone.
 */
export function checksGateReason(failed: Receipt[]): string {
  const parts = failed.map((r) => {
    const v = verdictOf(r);
    if (!v) return r.kind;
    const listed = v.newFailures.slice(0, 15).map((f) => sanitizeFailure(f, 200));
    const more = v.newCount - listed.length;
    const items = listed.length
      ? ` (untrusted tool output): ${listed.join("; ")}${more > 0 ? `; +${more} more` : ""}`
      : "";
    const pre =
      v.preExisting > 0
        ? `; ignore ${v.preExisting} pre-existing ${unit(r.kind, v.preExisting)} that also fail on the base commit`
        : "";
    return `${r.kind}: ${v.newCount} new failure(s) [${sanitizeFailure(v.note, 120)}]${items}${pre}`;
  });
  return `checks failed: ${parts.join(failed.some((r) => verdictOf(r)) ? " | " : ", ")}`;
}

/** e.g. "0 new failures (273 pre-existing lint errors, 19 pre-existing test failures)". */
export function checksStatusLine(receipts: readonly Receipt[]): string | undefined {
  let fresh = 0;
  let any = false;
  const pre: string[] = [];
  for (const r of receipts) {
    const v = verdictOf(r);
    if (!v) continue;
    any = true;
    fresh += Math.max(0, Math.floor(v.newCount));
    if (v.preExisting > 0)
      pre.push(`${Math.floor(v.preExisting)} pre-existing ${unit(r.kind, v.preExisting)}`);
    else if (v.preExisting < 0) pre.push(`${r.kind} failing on base`);
    if (v.flaky?.length) pre.push(`${v.flaky.length} flaky ${unit(r.kind, v.flaky.length)}`);
  }
  if (!any) return undefined;
  return `${fresh} new failure${fresh === 1 ? "" : "s"}${pre.length ? ` (${pre.join(", ")})` : ""}`;
}
