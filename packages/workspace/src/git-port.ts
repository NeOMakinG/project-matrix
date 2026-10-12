import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { GitPort } from "@matrix/core";
import {
  gitLocation,
  hostExecutor,
  type LineExecutor,
  readInsideRoot,
  runToCompletion,
  safeGitEnv,
  verifyWorktreeLink,
} from "@matrix/sandbox";
import type { TrustedWorktrees } from "./trusted.js";

/** GitPort for agent-touched worktrees: host-owned gitdir only, hardened git, no symlink following. */
export class WorktreeGitPort implements GitPort {
  readonly #executor: LineExecutor;
  readonly #trusted: TrustedWorktrees;

  constructor(options: { trusted: TrustedWorktrees; executor?: LineExecutor }) {
    this.#executor = options.executor ?? hostExecutor;
    this.#trusted = options.trusted;
  }

  async #run(gitdir: string, args: string[], extra: Array<[string, string]> = []) {
    return runToCompletion(this.#executor, {
      cmd: ["git", ...args],
      cwd: gitdir,
      env: safeGitEnv({}, extra),
      timeoutMs: 120_000,
    });
  }

  /** Every filter driver in the (trusted) config is disabled, so worktree attributes can't trigger one. */
  async #filterOverrides(gitdir: string): Promise<Array<[string, string]>> {
    const listed = await this.#run(gitdir, [
      "--git-dir",
      gitdir,
      "config",
      "--name-only",
      "--get-regexp",
      "^filter\\.",
    ]);
    const names = new Set(
      listed.stdout
        .split("\n")
        .map((l) => /^filter\.(.+)\.[^.]+$/.exec(l.trim())?.[1])
        .filter((n): n is string => Boolean(n)),
    );
    return [...names].flatMap(
      (n): Array<[string, string]> => [
        [`filter.${n}.clean`, ""],
        [`filter.${n}.smudge`, ""],
        [`filter.${n}.process`, ""],
        [`filter.${n}.required`, "false"],
      ],
    );
  }

  async #git(workdir: string, args: string[], withTree = false): Promise<string> {
    const { gitdir } = await this.#trusted.lookup(workdir);
    await verifyWorktreeLink(workdir, gitdir);
    const result = await this.#run(
      gitdir,
      [...gitLocation(gitdir, withTree ? workdir : undefined), ...args],
      await this.#filterOverrides(gitdir),
    );
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
