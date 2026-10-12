import type { Issue, IssueStore, Occurrence } from "./group.js";

export interface VerifyOptions {
  /** Hours before the fix deploy used as the baseline. */
  beforeHours: number;
  /** Hours after the fix deploy to observe. */
  afterHours: number;
  /** After-rate must be at most this fraction of the baseline rate. */
  maxRatio: number;
  /** Absolute occurrences per hour tolerated after the fix (noise floor). */
  floorPerHour: number;
}

export const defaultVerify: VerifyOptions = {
  beforeHours: 24,
  afterHours: 6,
  maxRatio: 0.1,
  floorPerHour: 0,
};

export interface VerifyResult {
  outcome: "resolved" | "reopened" | "pending";
  beforeCount: number;
  afterCount: number;
  beforePerHour: number;
  afterPerHour: number;
  observedHours: number;
  reason: string;
}

const HOUR = 3_600_000;
const sum = (list: Occurrence[]) => list.reduce((n, o) => n + o.count, 0);
const round = (n: number) => Number(n.toFixed(4));

/**
 * Compares the issue's occurrence rate in a window before the fix deploy with the window after it.
 * - Any occurrence tagged with the fix release (or later untagged) counts against the fix.
 * - "pending" until the after-window has fully elapsed, unless the error is already clearly back.
 */
export async function verifyFix(
  issue: Issue,
  deployedAt: string,
  store: IssueStore,
  now: string,
  options: VerifyOptions = defaultVerify,
): Promise<VerifyResult> {
  const deploy = Date.parse(deployedAt);
  const nowMs = Date.parse(now);
  const beforeFrom = new Date(deploy - options.beforeHours * HOUR).toISOString();
  const afterTo = new Date(Math.min(nowMs, deploy + options.afterHours * HOUR)).toISOString();
  const before = await store.occurrences(issue.fingerprint, beforeFrom, deployedAt);
  const after = await store.occurrences(issue.fingerprint, deployedAt, afterTo);

  const observedHours = Math.max(0, (Date.parse(afterTo) - deploy) / HOUR);
  const beforeCount = sum(before);
  const afterCount = sum(after);
  const beforePerHour = beforeCount / options.beforeHours;
  const afterPerHour = observedHours > 0 ? afterCount / observedHours : 0;
  const allowed = Math.max(options.floorPerHour, beforePerHour * options.maxRatio);
  const base = {
    beforeCount,
    afterCount,
    beforePerHour: round(beforePerHour),
    afterPerHour: round(afterPerHour),
    observedHours: round(observedHours),
  };

  const complete = observedHours >= options.afterHours;
  const exceeded = afterCount > 0 && afterPerHour > allowed;
  // Fail fast: by the end of the window the rate could only be lower if it stays at zero,
  // so once the count alone exceeds the whole-window budget the fix has clearly failed.
  const budget = allowed * options.afterHours;
  if (exceeded && (complete || afterCount > budget)) {
    return {
      outcome: "reopened",
      ...base,
      reason: `${afterCount} occurrences after deploy (${round(afterPerHour)}/h > allowed ${round(allowed)}/h)`,
    };
  }
  if (!complete) {
    return {
      outcome: "pending",
      ...base,
      reason: `observed ${round(observedHours)}h of ${options.afterHours}h`,
    };
  }
  return {
    outcome: "resolved",
    ...base,
    reason:
      afterCount === 0
        ? `no occurrences in ${options.afterHours}h after deploy (baseline ${round(beforePerHour)}/h)`
        : `rate dropped to ${round(afterPerHour)}/h from ${round(beforePerHour)}/h`,
  };
}
