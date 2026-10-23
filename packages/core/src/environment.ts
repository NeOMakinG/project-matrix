import type { Receipt } from "./ports.js";
import type { PhaseContext } from "./ports-internal.js";

/**
 * Installs a project's dependencies in the run worktree before checks (existing repos: npm ci,
 * pnpm/yarn/bun frozen installs). A failure is an environment problem, never the implementer's.
 */
export type DependencySetupPort = (
  ctx: PhaseContext,
  /** `checks` runs on the cleaned committed tree; only then may an install be cached. */
  stage: "implement" | "checks",
) => Promise<{ ok: boolean; summary: string; receipts: Receipt[] }>;

/** Exit codes a shell or launcher returns when the command itself cannot run. */
const NOT_RUNNABLE = new Set([126, 127]);
const MISSING_COMMAND =
  /((?:^|\n)(?:\/bin\/)?(?:ba|da|z)?sh: (?:line )?(?:\d+: )?[^\s:]+: (?:command )?not found|(?:^|\n)[^\n]*spawn [^\s:]+ ENOENT|Cannot find module '[^']*node_modules\/\.bin\/[^']*')/;

/**
 * Why a failed check is clearly the environment's fault (missing binary or dependencies), or
 * undefined when it may be a genuine code failure the implementer must fix. Deliberately narrow:
 * a missing module the agent's own code imports (`./foo`) stays a code failure.
 */
export function environmentFailure(
  code: number,
  output: string,
  _durationMs: number,
): string | undefined {
  if (code === 0) return undefined;
  if (NOT_RUNNABLE.has(code)) return `command not runnable (exit ${code})`;
  const missing = MISSING_COMMAND.exec(output)?.[1];
  if (missing) return `missing command or dependency: ${missing.trim().slice(0, 200)}`;
  return undefined;
}
