import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PreparedWorkspace, Workspace, WorkspaceTarget } from "@matrix/core";
import { hostExecutor, type LineExecutor, runToCompletion } from "@matrix/sandbox";

export interface NativeWorkspaceOptions {
  /** Directory under which worktrees are created: `<root>/<project>/<ticket>`. */
  root: string;
  executor?: LineExecutor;
  gitBinary?: string;
}

export function safeSegment(value: string): string {
  const s = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^[.-]+/, "");
  if (!s) throw new Error(`invalid path segment: ${JSON.stringify(value)}`);
  return s.slice(0, 80);
}

/** One git worktree per ticket, created by Matrix itself. */
export class NativeWorkspace implements Workspace {
  readonly kind = "native" as const;
  readonly #o: NativeWorkspaceOptions;

  constructor(options: NativeWorkspaceOptions) {
    this.#o = options;
  }

  async #git(cwd: string, args: string[]): Promise<string> {
    const result = await runToCompletion(this.#o.executor ?? hostExecutor, {
      cmd: [this.#o.gitBinary ?? "git", ...args],
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} failed (${result.exitCode}): ${result.stderrTail.trim().slice(-500)}`);
    }
    return result.stdout.trim();
  }

  async prepare(target: WorkspaceTarget): Promise<PreparedWorkspace> {
    await this.#git(target.repoPath, ["check-ref-format", "--branch", target.branch]);
    const workdir = join(this.#o.root, safeSegment(target.projectId), safeSegment(target.ticketId));
    if (existsSync(workdir)) {
      const branch = await this.#git(workdir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branch !== target.branch) {
        throw new Error(`workspace ${workdir} is on ${branch}, expected ${target.branch}`);
      }
      return { workdir, ref: workdir };
    }
    await mkdir(dirname(workdir), { recursive: true });
    const exists = await this.#git(target.repoPath, ["branch", "--list", target.branch]);
    if (exists) await this.#git(target.repoPath, ["worktree", "add", workdir, target.branch]);
    else await this.#git(target.repoPath, ["worktree", "add", "-b", target.branch, workdir, target.baseBranch]);
    return { workdir, ref: workdir };
  }

  async cleanup(prepared: PreparedWorkspace): Promise<void> {
    if (!existsSync(prepared.workdir)) return;
    const commonDir = await this.#git(prepared.workdir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await this.#git(dirname(commonDir), ["--git-dir", commonDir, "worktree", "remove", "--force", prepared.workdir]);
  }
}
