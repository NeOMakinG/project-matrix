import { type BaselineRun, newFailures } from "./check-baseline.js";
import type { Failure } from "./check-parsers.js";

/**
 * At most this many new failures may be excused as flaky in one check. More than that passing on
 * a retry is not "timing noise": it is treated as real (an agent must not be able to hide a
 * regression by making it nondeterministic at scale).
 */
export const MAX_FLAKY = 3;

export interface RetryVerdict<T extends Failure = Failure> {
  /** New failures that failed again on the retry: they count. */
  confirmed: T[];
  /** New failures that passed on the retry: reported separately, do not fail the check. */
  flaky: T[];
  note?: string;
}

/**
 * Splits a check's new failures by a single retry of the same check on the same tree. Anything
 * the retry cannot vouch for (unparseable output, timeout, too many vanishing failures) stays
 * confirmed: retries can only excuse a few individually identified failures, never a whole run.
 */
export function confirmByRetry<T extends Failure>(
  fresh: T[],
  retry: BaselineRun | undefined,
  base?: readonly Failure[],
): RetryVerdict<T> {
  if (!fresh.length) return { confirmed: [], flaky: [] };
  if (!retry) return { confirmed: fresh, flaky: [], note: "retry unavailable" };
  if (retry.code === 124) return { confirmed: fresh, flaky: [], note: "retry timed out" };
  // A failing retry that cannot be parsed cannot clear anything.
  const again = retry.code === 0 ? [] : retry.failures;
  if (again === null) return { confirmed: fresh, flaky: [], note: "retry output unparseable" };
  // A retry that fails differently (new-vs-base failures the first run did not have, e.g. test
  // names that change per run) proves nothing about the first run's failures.
  if (base && newFailures(newFailures(again, base), fresh).length)
    return { confirmed: fresh, flaky: [], note: "retry failed differently: counted as real" };
  const flaky = newFailures(fresh, again);
  const confirmed = newFailures(fresh, flaky);
  if (flaky.length > MAX_FLAKY)
    return {
      confirmed: fresh,
      flaky: [],
      note: `${flaky.length} new failures passed on retry (> ${MAX_FLAKY}): counted as real`,
    };
  return {
    confirmed,
    flaky,
    ...(flaky.length ? { note: `${flaky.length} flaky (passed on retry)` } : {}),
  };
}
