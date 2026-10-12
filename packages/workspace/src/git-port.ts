import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { GitPort } from "@matrix/core";
import {
  findNestedGitEntries,
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
    const entry = await this.#trusted.lookup(workdir);
    const { gitdir } = entry;
    await verifyWorktreeLink(workdir, gitdir);
    await this.#preflight(workdir, gitdir, entry.baseSha);
    const result = await this.#run(
      gitdir,
      [...gitLocation(gitdir, withTree ? workdir : undefined), ...args],
      await this.#filterOverrides(gitdir),
    );
    if (result.exitCode !== 0)
      throw new Error(`git ${args[0]} failed: ${result.stderrTail.trim().slice(-300)}`);
    return result.stdout;
  }

  /** Nested repos or gitlinks would make host git recurse into agent-controlled metadata. */
  async #preflight(workdir: string, gitdir: string, baseSha?: string): Promise<void> {
    const nested = await findNestedGitEntries(workdir);
    if (nested.length > 0) throw new Error(`tampering: nested git repository at ${nested[0]}`);
    const loc = ["--git-dir", gitdir];
    const base = baseSha ? await this.#gitlinks(gitdir, baseSha) : new Map<string, string>();
    const check = (links: Map<string, string>, where: string) => {
      for (const [path, sha] of links) {
        if (base.get(path) !== sha) throw new Error(`tampering: gitlink ${path} in ${where}`);
      }
    };
    check(await this.#gitlinks(gitdir, "HEAD"), "HEAD");
    if (baseSha) {
      const range = await this.#run(gitdir, [
        ...loc,
        "rev-list",
        "--max-count=1001",
        `${baseSha}..HEAD`,
      ]);
      const commits = range.stdout.split("\n").filter(Boolean);
      if (commits.length > 1000) throw new Error("tampering: more than 1000 commits since base");
      for (const commit of commits) check(await this.#gitlinks(gitdir, commit), `commit ${commit}`);
    }
    const staged = await this.#run(gitdir, [...loc, "ls-files", "--stage", "-z"]);
    check(gitlinkRecords(staged.stdout, "index"), "the index");
  }

  async #gitlinks(gitdir: string, rev: string): Promise<Map<string, string>> {
    const tree = await this.#run(gitdir, ["--git-dir", gitdir, "ls-tree", "-r", "-z", rev]);
    if (tree.exitCode !== 0) throw new Error(`git ls-tree ${rev} failed`);
    return gitlinkRecords(tree.stdout, "tree");
  }

  /**
   * Makes the worktree exactly the committed tree before checks run: removes untracked and
   * gitignored files host-side, then requires a clean tree. Returns the checked HEAD SHA.
   */
  async cleanForChecks(workdir: string): Promise<string> {
    await this.#git(workdir, ["clean", "-ffdx", "-q"], true);
    if (!(await this.isClean(workdir)))
      throw new Error("worktree has uncommitted changes after clean");
    return this.headSha(workdir);
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
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--no-renames",
        "--ignore-submodules=all",
      ],
      true,
    );
  }

  /** Exit-status comparison against the trusted gitdir (0 = same, 1 = different). */
  async #same(workdir: string, args: string[]): Promise<boolean> {
    const { gitdir } = await this.#trusted.lookup(workdir);
    const result = await this.#run(
      gitdir,
      [...gitLocation(gitdir, workdir), ...args],
      await this.#filterOverrides(gitdir),
    );
    if (result.exitCode > 1)
      throw new Error(`git ${args[0]} failed: ${result.stderrTail.trim().slice(-300)}`);
    return result.exitCode === 0;
  }

  /** No changes at all: status, index == HEAD and worktree == index, submodules NOT ignored for the latter two. */
  async isClean(workdir: string): Promise<boolean> {
    if ((await this.status(workdir)).trim() !== "") return false;
    if (
      !(await this.#same(workdir, [
        "diff",
        "--cached",
        "--quiet",
        "--ignore-submodules=none",
        "HEAD",
      ]))
    )
      return false;
    return this.#same(workdir, ["diff", "--quiet", "--ignore-submodules=none"]);
  }

  async treeState(workdir: string): Promise<string> {
    const hash = createHash("sha256");
    hash.update(await this.headSha(workdir));
    hash.update(await this.status(workdir));
    hash.update(
      await this.#git(
        workdir,
        ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"],
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

/**
 * Gitlinks from NUL-terminated `ls-tree -z` ("mode type sha\tpath") or `ls-files --stage -z`
 * ("mode sha stage\tpath") output. Each record is split at its FIRST tab, so paths may contain
 * newlines, tabs, spaces or any unicode.
 */
export function gitlinkRecords(out: string, format: "tree" | "index"): Map<string, string> {
  const links = new Map<string, string>();
  for (const record of out.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab <= 0) continue;
    const meta = record.slice(0, tab).split(" ");
    if (meta[0] !== "160000") continue;
    const sha = format === "tree" ? meta[2] : meta[1];
    if (sha) links.set(record.slice(tab + 1), sha);
  }
  return links;
}
