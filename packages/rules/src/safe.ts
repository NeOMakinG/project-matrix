import safeRegex from "safe-regex2";

/** Files larger than this are not scanned by regex rules (reported instead). */
export const MAX_REGEX_SCAN_BYTES = 1_000_000;

/**
 * Compiles a rule regex, rejecting patterns prone to catastrophic backtracking (ReDoS).
 * Rule authors get a clear error instead of a hung check.
 */
export function compileSafeRegex(pattern: string, flags = ""): RegExp {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (e) {
    throw new Error(`invalid regex /${pattern}/: ${(e as Error).message}`);
  }
  if (!safeRegex(re))
    throw new Error(`unsafe regex /${pattern}/ (possible catastrophic backtracking)`);
  return re;
}
