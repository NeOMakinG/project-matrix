import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { GitPort, Receipt } from "@matrix/core";
import {
  findNestedGitEntries,
  gitLocation,
  hostExecutor,
  type LineExecutor,
  runToCompletion,
  safeGitEnv,
  verifyWorktreeLink,
} from "@matrix/sandbox";
import { disposablePolicy } from "./artifact-policy.js";
import type { TrustedWorktrees } from "./trusted.js";

const exec = promisify(execFile);

export interface CandidateBinding {
  tree: string;
  objects: Array<{ path: string; sha: string }>;
}

async function readSource(root: string, path: string): Promise<Buffer> {
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."))
    throw new Error("invalid source path");
  const realRoot = await realpath(root);
  const check = async () => {
    for (let depth = 1; depth <= segments.length; depth++) {
      const stat = await lstat(join(realRoot, ...segments.slice(0, depth)));
      if (stat.isSymbolicLink()) throw new Error("tampering: source symlink");
    }
  };
  await check();
  const full = join(realRoot, path);
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 ** 2)
      throw new Error("tampering: non-regular, hardlinked or oversized source");
    await check();
    const content = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(full);
    await check();
    if (
      after.nlink !== 1 ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error("source changed while reading");
    return content;
  } finally {
    await handle.close();
  }
}

/** GitPort for agent-touched worktrees: host-owned gitdir only, hardened git, no symlink following. */
/**
 * Branches the implementation commit gate accepts: `matrix/<ticket>` (native worktrees),
 * `matrix-<ticket>` (Orca) or Orca's `branchPrefix: git-username` form `<user>/matrix-<ticket>`,
 * and, when the host recorded the branch at prepare time, only exactly that one. Worktrees recorded before the
 * branch was (no `recorded`) accept the prefixed form only when the host-owned worktree path ends
 * in that same `matrix-<ticket>` (Orca names the checkout directory after `--name`).
 */
export function isTicketBranch(ref: string, recorded?: string, workdir?: string): boolean {
  if (!ref.startsWith("refs/heads/")) return false;
  const name = ref.slice("refs/heads/".length);
  const prefixed = /^[^/]+\/(matrix-[^/]+)$/.exec(name);
  const ticket = name.startsWith("matrix/") || name.startsWith("matrix-") || prefixed !== null;
  if (!ticket) return false;
  // A recorded branch pins the gate to exactly that name.
  if (recorded !== undefined) return name === recorded;
  if (!prefixed) return true;
  return workdir !== undefined && basename(workdir) === prefixed[1];
}

export class WorktreeGitPort implements GitPort {
  readonly #executor: LineExecutor;
  readonly #trusted: TrustedWorktrees;

  constructor(options: { trusted: TrustedWorktrees; executor?: LineExecutor }) {
    this.#executor = options.executor ?? hostExecutor;
    this.#trusted = options.trusted;
  }

  async #run(
    gitdir: string,
    args: string[],
    extra: Array<[string, string]> = [],
    env: Record<string, string> = {},
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    return runToCompletion(
      this.#executor,
      {
        cmd: ["git", ...args],
        cwd: gitdir,
        env: safeGitEnv(env, extra),
        timeoutMs: 120_000,
      },
      signal,
    );
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

  async #git(
    workdir: string,
    args: string[],
    withTree = false,
    signal?: AbortSignal,
  ): Promise<string> {
    const entry = await this.#trusted.lookup(workdir);
    const { gitdir } = entry;
    await verifyWorktreeLink(workdir, gitdir);
    await this.#preflight(workdir, gitdir, entry.baseSha);
    const result = await this.#run(
      gitdir,
      [...gitLocation(gitdir, withTree ? workdir : undefined), ...args],
      await this.#filterOverrides(gitdir),
      {},
      signal,
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
   * Requires the committed tree before checks; preserves artifacts authorized by trusted BASE.
   */
  async cleanForChecks(workdir: string): Promise<string> {
    const disposable = await this.#assertNoHiddenArtifacts(workdir);
    const others = await this.#git(workdir, ["ls-files", "--others", "-z"], true);
    if (others.split("\0").some((path) => path && !disposable.has(path)))
      throw new Error("untracked artifacts preserved; cleanup refused");
    const cached = await this.#git(workdir, ["ls-files", "--cached", "-z"]);
    const stagedArtifacts = cached.split("\0").filter((path) => disposable.has(path));
    if (stagedArtifacts.length)
      await this.#git(workdir, ["update-index", "--force-remove", "--", ...stagedArtifacts]);
    if (!(await this.isClean(workdir)))
      throw new Error("worktree has uncommitted changes after clean");
    return this.headSha(workdir);
  }

  async #assertNoHiddenArtifacts(workdir: string, refuseHidden = true): Promise<Set<string>> {
    const { baseSha } = await this.#trusted.lookup(workdir);
    if (!baseSha) throw new Error("trusted BASE required for artifact policy");
    const tree = await this.#git(workdir, ["ls-tree", "-z", baseSha, "--", "matrix.config.ts"]);
    const record = tree.split("\0").filter(Boolean)[0];
    let matches = (_path: string) => false;
    if (record) {
      if (!/^100644 blob [0-9a-f]{40,64}\tmatrix\.config\.ts$/.test(record))
        throw new Error("invalid trusted BASE artifact config entry");
      const sha = record.split(" ")[2]!.split("\t")[0]!;
      const size = Number((await this.#git(workdir, ["cat-file", "-s", sha])).trim());
      if (!Number.isSafeInteger(size) || size > 1024 * 1024)
        throw new Error("trusted BASE artifact config exceeds size limit");
      matches = disposablePolicy(await this.#git(workdir, ["cat-file", "blob", sha]));
    }
    const tracked = new Set(
      (await this.#git(workdir, ["ls-tree", "-r", "--name-only", "-z", "HEAD"])).split("\0"),
    );
    const disposable = new Set<string>();
    const all = await this.#git(workdir, ["ls-files", "--others", "-z"], true);
    const cached = await this.#git(workdir, ["ls-files", "--cached", "-z"]);
    for (const path of `${all}${cached}`.split("\0").filter(Boolean)) {
      if (!tracked.has(path) && matches(path)) disposable.add(path);
    }
    const visible = new Set(
      (await this.#git(workdir, ["ls-files", "--others", "--exclude-standard", "-z"], true)).split(
        "\0",
      ),
    );
    for (const path of all.split("\0").filter(Boolean)) {
      if (refuseHidden && !disposable.has(path) && !visible.has(path))
        throw new Error(`ignored artifact preserved; trusted BASE deny-clean policy: ${path}`);
    }
    return disposable;
  }

  async commitImplementation(
    workdir: string,
    options: {
      expectedHead: string;
      approvedPaths: string[];
      message: string;
      scan: (snapshot: string, binding: CandidateBinding) => Promise<Receipt>;
      derivedGraph?: {
        generate: (staging: string) => Promise<Record<string, string>>;
        publish: (files: Record<string, { content: string; previous?: string }>) => void;
      };
      signal?: AbortSignal;
    },
  ): Promise<{ headSha: string; receipt: Receipt }> {
    options.signal?.throwIfAborted();
    const disposable = await this.#assertNoHiddenArtifacts(workdir);
    const head = await this.headSha(workdir);
    if (head !== options.expectedHead)
      throw new Error("implementation HEAD changed before handover");
    const branch = (await this.#git(workdir, ["symbolic-ref", "HEAD"])).trim();
    const trusted = await this.#trusted.lookup(workdir);
    if (!isTicketBranch(branch, trusted.branch, workdir))
      throw new Error("implementation commit requires a Matrix ticket branch");
    const state = await this.treeState(workdir);
    const status = await this.#git(
      workdir,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
      true,
    );
    const paths = status
      .split("\0")
      .filter(Boolean)
      .filter((entry) => !disposable.has(entry.slice(3)))
      .map((entry) => {
        if (entry.slice(0, 2).includes("U")) throw new Error("unmerged implementation files");
        return entry.slice(3);
      });
    for (const path of paths) {
      const segments = path.split("/");
      if (
        segments.some(
          (segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."),
        ) ||
        !options.approvedPaths.some((allowed) => path === allowed || path.startsWith(`${allowed}/`))
      )
        throw new Error(`unapproved implementation path: ${path}`);
      for (let depth = 1; depth <= segments.length; depth++) {
        try {
          if ((await lstat(join(workdir, ...segments.slice(0, depth)))).isSymbolicLink())
            throw new Error(`tampering: implementation symlink at ${path}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    const { gitdir } = trusted;
    const temporary = await mkdtemp(join(tmpdir(), "matrix-handover-"));
    try {
      const source = join(temporary, "source");
      await mkdir(source, { mode: 0o700 });
      const staging = join(temporary, "staging");
      await mkdir(staging, { mode: 0o700 });
      const files = await this.#git(workdir, ["ls-files", "--cached", "--others", "-z"], true);
      for (const path of new Set(files.split("\0").filter(Boolean))) {
        if (disposable.has(path)) continue;
        options.signal?.throwIfAborted();
        const stat = await lstat(join(workdir, path)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!stat) continue;
        const content = await readSource(workdir, path);
        const target = join(staging, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: stat.mode & 0o777, flag: "wx" });
      }
      if ((await this.treeState(workdir)) !== state)
        throw new Error("implementation changed while preparing staging");
      const generated: Record<string, { content: string; previous?: string }> = {};
      if (options.derivedGraph) {
        const files = await options.derivedGraph.generate(staging);
        const allowed = [".matrix/graph/code.json", ".matrix/graph/GRAPH.md"];
        if (
          Object.keys(files).length !== allowed.length ||
          allowed.some((path) => typeof files[path] !== "string")
        )
          throw new Error("invalid host-derived graph artifacts");
        for (const [path, content] of Object.entries(files)) {
          const previous = await readSource(staging, path).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          generated[path] = {
            content,
            ...(previous === undefined ? {} : { previous: previous.toString("utf8") }),
          };
          options.signal?.throwIfAborted();
          await mkdir(dirname(join(staging, path)), { recursive: true, mode: 0o700 });
          await writeFile(join(staging, path), content, { mode: 0o644 });
        }
      }
      const env = { GIT_INDEX_FILE: join(temporary, "index"), GIT_LITERAL_PATHSPECS: "1" };
      const candidate = async (...args: string[]) => {
        const result = await this.#run(
          gitdir,
          [...gitLocation(gitdir, staging), ...args],
          await this.#filterOverrides(gitdir),
          env,
          options.signal,
        );
        if (result.exitCode !== 0)
          throw new Error(
            `implementation git ${args[0]} failed (exit ${result.exitCode}): ${result.stderrTail.trim().slice(-300)}`,
          );
        return result.stdout.trim();
      };
      await candidate("read-tree", head);
      if (paths.length) await candidate("add", "-A", "--", ...paths);
      if (Object.keys(generated).length)
        await candidate("add", "-A", "--", ...Object.keys(generated));
      const index = await candidate("ls-files", "--stage", "-z");
      if (
        index
          .split("\0")
          .filter(Boolean)
          .some((record) => !/^(100644|100755) [0-9a-f]+ 0\t/.test(record))
      )
        throw new Error("tampering: non-regular implementation snapshot entries");
      const tree = await candidate("write-tree");
      const records = await candidate("ls-tree", "-r", "-z", tree);
      const binding: CandidateBinding = { tree, objects: [] };
      let bytes = 0;
      for (const record of records.split("\0").filter(Boolean)) {
        const tab = record.indexOf("\t");
        const [mode, type, sha] = record.slice(0, tab).split(" ");
        const path = record.slice(tab + 1);
        if (
          !/^(100644|100755)$/.test(mode ?? "") ||
          type !== "blob" ||
          !sha ||
          !/^[0-9a-f]{40,64}$/.test(sha) ||
          tab < 0 ||
          path.split("/").some((part) => !part || part === "." || part === "..")
        )
          throw new Error("invalid candidate blob");
        options.signal?.throwIfAborted();
        const raw = await exec("git", [...gitLocation(gitdir), "cat-file", "blob", sha], {
          cwd: gitdir,
          env: safeGitEnv(),
          encoding: "buffer",
          maxBuffer: 16 * 1024 ** 2,
          timeout: 60_000,
          signal: options.signal,
        });
        bytes += raw.stdout.length;
        if (bytes > 128 * 1024 ** 2 || binding.objects.length >= 100_000)
          throw new Error("candidate scan limit");
        const target = join(source, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, raw.stdout, { mode: 0o600, flag: "wx" });
        binding.objects.push({ path, sha });
      }
      const receipt = await options.scan(source, structuredClone(binding));
      if (receipt.kind !== "secret-scan" || !receipt.ok)
        throw new Error("implementation secret scan failed closed");
      options.signal?.throwIfAborted();
      await this.#assertNoHiddenArtifacts(workdir);
      if ((await this.treeState(workdir)) !== state || (await this.headSha(workdir)) !== head)
        throw new Error("implementation changed during secret scan");
      if (tree === (await this.#git(workdir, ["rev-parse", "HEAD^{tree}"])).trim())
        return {
          headSha: head,
          receipt: { ...receipt, data: { scan: receipt.data, headSha: head, ...binding } },
        };
      options.signal?.throwIfAborted();
      let finalState = state;
      if (Object.keys(generated).length) {
        options.derivedGraph?.publish(generated);
        options.signal?.throwIfAborted();
        const refreshed = await this.#run(
          gitdir,
          [...gitLocation(gitdir, workdir), "update-index", "--refresh"],
          await this.#filterOverrides(gitdir),
          env,
          options.signal,
        );
        if (refreshed.exitCode !== 0)
          throw new Error("implementation differs from scanned final tree during index refresh");
        const matches = await this.#run(
          gitdir,
          [
            ...gitLocation(gitdir, workdir),
            "diff-files",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=none",
          ],
          await this.#filterOverrides(gitdir),
          env,
          options.signal,
        );
        const untracked = await this.#run(
          gitdir,
          [...gitLocation(gitdir, workdir), "ls-files", "--others", "-z"],
          await this.#filterOverrides(gitdir),
          env,
          options.signal,
        );
        if (
          matches.exitCode !== 0 ||
          untracked.exitCode !== 0 ||
          untracked.stdout.split("\0").some((path) => path && !disposable.has(path))
        )
          throw new Error("implementation differs from scanned final tree");
        finalState = await this.treeState(workdir);
      }
      const committed = await this.#run(
        gitdir,
        [...gitLocation(gitdir), "commit-tree", tree, "-p", head, "-m", options.message],
        [],
        {
          GIT_AUTHOR_NAME: "Matrix",
          GIT_AUTHOR_EMAIL: "matrix@localhost",
          GIT_COMMITTER_NAME: "Matrix",
          GIT_COMMITTER_EMAIL: "matrix@localhost",
        },
        options.signal,
      );
      const next = committed.stdout.trim();
      if (committed.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(next))
        throw new Error("implementation commit failed");
      options.signal?.throwIfAborted();
      if ((await this.treeState(workdir)) !== finalState)
        throw new Error("implementation changed before reference update");
      if (
        (await this.#git(workdir, ["symbolic-ref", "HEAD"], false, options.signal)).trim() !==
        branch
      )
        throw new Error("implementation branch changed during handover");
      await this.#git(workdir, ["update-ref", branch, next, head], false, options.signal);
      await this.#git(workdir, ["read-tree", tree], false, options.signal);
      if (!(await this.isClean(workdir)))
        throw new Error("implementation changed after commit; clean handover refused");
      return {
        headSha: next,
        receipt: { ...receipt, data: { scan: receipt.data, headSha: next, ...binding } },
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async headSha(workdir: string): Promise<string> {
    const sha = (await this.#git(workdir, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`unexpected HEAD ${sha}`);
    return sha;
  }

  /** Uncommitted or untracked changes, gitignored files excluded. */
  async status(workdir: string): Promise<string> {
    const disposable = await this.#assertNoHiddenArtifacts(workdir, false);
    const status = await this.#git(
      workdir,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
        "--ignore-submodules=all",
      ],
      true,
    );
    return status
      .split("\0")
      .filter((entry) => !disposable.has(entry.slice(3)))
      .join("\n");
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
    const disposable = await this.#assertNoHiddenArtifacts(workdir, false);
    const hash = createHash("sha256");
    hash.update(await this.headSha(workdir));
    const untracked = await this.#git(workdir, ["ls-files", "-z", "--cached", "--others"], true);
    for (const path of [...new Set(untracked.split("\0").filter(Boolean))].sort()) {
      if (disposable.has(path)) continue;
      hash.update(`\0${path}\0`);
      const full = join(workdir, path);
      const stat = await lstat(full).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) {
        hash.update("deleted");
        continue;
      }
      if (stat.isSymbolicLink()) hash.update(`link:${await readlink(full)}`);
      else if (stat.isFile()) hash.update(await readSource(workdir, path));
    }
    hash.update(await this.status(workdir));
    hash.update(
      await this.#git(
        workdir,
        ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"],
        true,
      ),
    );
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
