import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { GitPort } from "@matrix/core";
import {
  gitLocation,
  hostExecutor,
  type LineExecutor,
  readInsideRoot,
  resolveWorktreeGitDir,
  runToCompletion,
  safeGitEnv,
} from "@matrix/sandbox";

/** GitPort for agent-touched worktrees: host-owned gitdir only, hardened git, no symlink following. */
export class WorktreeGitPort implements GitPort {
  readonly #executor: LineExecutor;

  constructor(options: { executor?: LineExecutor } = {}) {
    this.#executor = options.executor ?? hostExecutor;
  }

  async #git(workdir: string, args: string[], withTree = false): Promise<string> {
    const { gitdir } = await resolveWorktreeGitDir(workdir);
    const result = await runToCompletion(this.#executor, {
      cmd: ["git", ...gitLocation(gitdir, withTree ? workdir : undefined), ...args],
      cwd: gitdir,
      env: safeGitEnv(),
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0)
      throw new Error(`git ${args[0]} failed: ${result.stderrTail.trim().slice(-300)}`);
    return result.stdout;
  }

  async headSha(workdir: string): Promise<string> {
    const sha = (await this.#git(workdir, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`unexpected HEAD ${sha}`);
    return sha;
  }

  /** Uncommitted or untracked changes, gitignored files excluded. */
  async status(workdir: string): Promise<string> {
    return this.#git(
      workdir,
      ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames"],
      true,
    );
  }

  async isClean(workdir: string): Promise<boolean> {
    return (await this.status(workdir)).trim() === "";
  }

  async treeState(workdir: string): Promise<string> {
    const hash = createHash("sha256");
    hash.update(await this.headSha(workdir));
    hash.update(await this.status(workdir));
    hash.update(
      await this.#git(
        workdir,
        ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv"],
        true,
      ),
    );
    const untracked = await this.#git(
      workdir,
      ["ls-files", "-z", "--others", "--exclude-standard"],
      true,
    );
    for (const path of untracked.split("\0").filter(Boolean).sort()) {
      hash.update(`\0${path}\0`);
      const full = join(workdir, path);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) hash.update(`link:${await readlink(full)}`);
      else if (stat.isFile()) hash.update(await readInsideRoot(workdir, path));
    }
    return hash.digest("hex");
  }
}
