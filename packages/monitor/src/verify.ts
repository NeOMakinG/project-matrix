import type { Issue, IssueStore, Occurrence } from "./group.js";

export interface VerifyOptions {
  /** Hours before the fix deploy used as the baseline. */
  beforeHours: number;
  /** Minimum hours to observe after the fix deploy. */
  afterHours: number;
  /** Upper bound when a rare error forces a longer window. */
  maxAfterHours: number;
  /**
   * Occurrences the baseline rate must predict for the window before silence means "fixed".
   * Rare errors get a longer window (up to maxAfterHours); if even that can't reach it,
   * zero occurrences ends as "inconclusive" instead of "resolved".
   */
  minExpected: number;
  /** After-rate must be at most this fraction of the baseline rate. */
  maxRatio: number;
  /** Absolute occurrences per hour tolerated after the fix (noise floor). */
  floorPerHour: number;
}

export const defaultVerify: VerifyOptions = {
  beforeHours: 24,
  afterHours: 6,
  maxAfterHours: 72,
  minExpected: 3,
  maxRatio: 0.1,
  floorPerHour: 0,
};

export interface FixDeploy {
  release: string;
  deployedAt: string;
  /** Releases deployed before the fix: their occurrences after the deploy come from clients not yet updated. */
  olderReleases: string[];
}

export interface VerifyResult {
  outcome: "resolved" | "reopened" | "pending" | "inconclusive";
  beforeCount: number;
  afterCount: number;
  /** After-deploy occurrences from releases older than the fix (stale clients, gradual rollout). */
  staleCount: number;
  beforePerHour: number;
  afterPerHour: number;
  windowHours: number;
  observedHours: number;
  reason: string;
}

const HOUR = 3_600_000;
const sum = (list: Occurrence[]) => list.reduce((n, o) => n + o.count, 0);
const round = (n: number) => Number(n.toFixed(4));

/**
 * Compares the issue's rate in a baseline window before the fix deploy with the window after it.
 * Release-aware: after the deploy, only occurrences from the fix release (or untagged ones, to stay
 * conservative) count against the fix; occurrences tagged with an older release are reported as stale.
 */
export async function verifyFix(
  issue: Pick<Issue, "fingerprint">,
  deploy: FixDeploy,
  store: IssueStore,
  now: string,
  options: VerifyOptions = defaultVerify,
): Promise<VerifyResult> {
  const deployMs = Date.parse(deploy.deployedAt);
  const nowMs = Date.parse(now);
  const beforeFrom = new Date(deployMs - options.beforeHours * HOUR).toISOString();
  const before = await store.occurrences(issue.fingerprint, beforeFrom, deploy.deployedAt);
  const beforeCount = sum(before);
  const beforePerHour = beforeCount / options.beforeHours;

  // Rare errors need a longer window before silence means anything.
  const needed = beforePerHour > 0 ? options.minExpected / beforePerHour : Number.POSITIVE_INFINITY;
  const windowHours = Math.min(options.maxAfterHours, Math.max(options.afterHours, needed));
  const windowEnd = deployMs + windowHours * HOUR;
  const afterTo = new Date(Math.min(nowMs, windowEnd)).toISOString();
  const afterAll = await store.occurrences(issue.fingerprint, deploy.deployedAt, afterTo);
  const stale = afterAll.filter(
    (o) => o.release !== undefined && deploy.olderReleases.includes(o.release),
  );
  const after = afterAll.filter((o) => !stale.includes(o));

  const observedHours = Math.max(0, (Date.parse(afterTo) - deployMs) / HOUR);
  const afterCount = sum(after);
  const staleCount = sum(stale);
  const afterPerHour = observedHours > 0 ? afterCount / observedHours : 0;
  const allowed = Math.max(options.floorPerHour, beforePerHour * options.maxRatio);
  const base = {
    beforeCount,
    afterCount,
    staleCount,
    beforePerHour: round(beforePerHour),
    afterPerHour: round(afterPerHour),
    windowHours: round(windowHours),
    observedHours: round(observedHours),
  };

  const complete = nowMs >= windowEnd;
  const exceeded = afterCount > 0 && afterPerHour > allowed;
  // Fail fast once the count alone exceeds the budget for the whole window.
  const budget = allowed * windowHours;
  if (exceeded && (complete || afterCount > budget)) {
    return {
      outcome: "reopened",
      ...base,
      reason: `${afterCount} occurrences from ${deploy.release} after deploy (${round(afterPerHour)}/h > allowed ${round(allowed)}/h)`,
    };
  }
  if (!complete) {
    return {
      outcome: "pending",
      ...base,
      reason: `observed ${round(observedHours)}h of ${round(windowHours)}h`,
    };
  }
  const expected = beforePerHour * windowHours;
  if (afterCount === 0 && expected < options.minExpected) {
    return {
      outcome: "inconclusive",
      ...base,
      reason: `baseline too small (${beforeCount} in ${options.beforeHours}h predicts ${round(expected)} in ${round(windowHours)}h); silence proves nothing`,
    };
  }
  return {
    outcome: "resolved",
    ...base,
    reason:
      afterCount === 0
        ? `no occurrences from ${deploy.release} in ${round(windowHours)}h (baseline predicted ${round(expected)})`
        : `rate dropped to ${round(afterPerHour)}/h from ${round(beforePerHour)}/h`,
  };
}
