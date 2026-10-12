import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { PreparedWorkspace, Workspace, WorkspaceTarget } from "@matrix/core";
import {
  gitLocation,
  hostExecutor,
  type LineExecutor,
  runToCompletion,
  safeGitEnv,
  verifyWorktreeLink,
} from "@matrix/sandbox";
import { gitdirFromCommonDir, TrustedWorktrees } from "./trusted.js";

export interface NativeWorkspaceOptions {
  /** Directory under which worktrees are created: `<root>/<project>/<ticket>`. */
  root: string;
  /** Stops any runner still attached to a ticket (e.g. `PodmanSandbox.stop`) before its worktree is replaced. */
  stopRunners?: (target: { projectId: string; ticketId: string }) => Promise<unknown>;
  /** Host-side gitdir registry; defaults to `<root>/.matrix/worktrees.json` (outside every worktree). */
  trusted?: TrustedWorktrees;
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

  readonly trusted: TrustedWorktrees;

  constructor(options: NativeWorkspaceOptions) {
    this.#o = options;
    this.trusted =
      options.trusted ?? new TrustedWorktrees(join(options.root, ".matrix", "worktrees.json"));
  }

  /** Host git, always against host-owned metadata, never discovering anything from a worktree. */
  async #git(location: string[], args: string[]): Promise<string> {
    const result = await runToCompletion(this.#o.executor ?? hostExecutor, {
      cmd: [this.#o.gitBinary ?? "git", ...location, ...args],
      cwd: this.#o.root,
      env: safeGitEnv(),
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args[0]} failed (${result.exitCode}): ${result.stderrTail.trim().slice(-500)}`,
      );
    }
    return result.stdout.trim();
  }

  /** The canonical repo's git dir. Refuses repos whose `.git` is itself a pointer or symlink. */
  async #commonDir(repoPath: string): Promise<string> {
    const dotGit = join(repoPath, ".git");
    const stat = await lstat(dotGit);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`${repoPath} is not a canonical git repository`);
    return realpath(dotGit);
  }

  async prepare(target: WorkspaceTarget): Promise<PreparedWorkspace> {
    const commonDir = await this.#commonDir(target.repoPath);
    const repo = gitLocation(commonDir);
    await this.#git(repo, ["check-ref-format", "--branch", target.branch]);
    const workdir = join(this.#o.root, safeSegment(target.projectId), safeSegment(target.ticketId));
    if (existsSync(workdir)) {
      // Never reuse: a previous owner's runner may still be writing here (lease takeover).
      await this.#o.stopRunners?.({ projectId: target.projectId, ticketId: target.ticketId });
      await this.#remove(workdir, commonDir);
    }
    {
      await mkdir(dirname(workdir), { recursive: true });
      const exists = await this.#git(repo, ["branch", "--list", target.branch]);
      const add = exists
        ? ["worktree", "add", "--", workdir, target.branch]
        : ["worktree", "add", "-b", target.branch, "--", workdir, target.baseBranch];
      await this.#git(repo, add);
    }
    const gitdir = await gitdirFromCommonDir(commonDir, workdir);
    await verifyWorktreeLink(workdir, gitdir);
    await this.trusted.record(workdir, { gitdir, commonDir });
    const branch = await this.#git(gitLocation(gitdir), ["symbolic-ref", "--short", "HEAD"]);
    if (branch !== target.branch)
      throw new Error(`workspace ${workdir} is on ${branch}, expected ${target.branch}`);
    return { workdir, ref: JSON.stringify({ commonDir, gitdir }) };
  }

  async cleanup(prepared: PreparedWorkspace): Promise<void> {
    const { commonDir } = JSON.parse(prepared.ref) as { commonDir: string; gitdir: string };
    await this.#remove(prepared.workdir, commonDir);
    await this.trusted.forget(prepared.workdir);
  }

  async #remove(workdir: string, commonDir: string): Promise<void> {
    const prepared = { workdir };
    try {
      await verifyWorktreeLink(workdir, await gitdirFromCommonDir(commonDir, workdir));
      await this.#git(gitLocation(commonDir), [
        "worktree",
        "remove",
        "--force",
        "--",
        prepared.workdir,
      ]);
    } catch {
      // Tampered or partial worktree: remove files without trusting them, then let git forget it.
      await rm(prepared.workdir, { recursive: true, force: true });
      await this.#git(gitLocation(commonDir), ["worktree", "prune"]);
    }
  }
}
