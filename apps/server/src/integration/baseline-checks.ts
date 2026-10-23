import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  type BaselinePort,
  type BaselineRun,
  type CheckCommand,
  type CheckEvidence,
  checkArgv,
  type DependencySetupPort,
  environmentFailure,
  type FailureId,
  MAX_FAILURES,
  type PhaseContext,
  resolveParser,
  runCheck,
  type Sandbox,
  sanitizeFailure,
} from "@matrix/core";
import { safeGitEnv } from "@matrix/sandbox";
import { safeSegment } from "@matrix/workspace";

const run = promisify(execFile);

export interface BaselineChecksOptions {
  sandbox: Sandbox;
  /** Same dependency setup the run worktree gets before checks. */
  setup?: DependencySetupPort;
  /** Host-only state dir: `<root>/cache` (results) and `<root>/worktrees` (temporary trees). */
  root: string;
  /** Trusted (host-side) HEAD of a run worktree. */
  headSha(workdir: string): Promise<string>;
  /** Projects whose checks compare by default (existing repos); others are strict. */
  compareByDefault(ctx: PhaseContext): boolean;
}

/**
 * Bump when the way base results are produced or parsed changes. 3: failures are `{key, text}`
 * with hash keys of the full normalized message (v2 cached truncated strings whose re-trim made
 * every long message look new).
 */
const CACHE_VERSION = 3;
/** Longest failure key accepted from the cache (key parts are bounded by the parsers). */
const MAX_KEY = 2048;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const LOCKFILE =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

/** Canonical git dir of the registered repo (refuses a `.git` pointer or symlink). */
async function commonDir(repoPath: string): Promise<string> {
  const dotGit = join(repoPath, ".git");
  const stat = await lstat(dotGit);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("project repo is not a canonical git repository");
  return realpath(dotGit);
}

async function git(gitDir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["--git-dir", gitDir, ...args], {
    env: safeGitEnv(),
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout.trim();
}

/** A cached base result, re-validated on read (the cache dir is host-only, but stay defensive). */
function validRun(value: unknown): BaselineRun | undefined {
  const v = value as { code?: unknown; failures?: unknown } | null;
  if (!v || !Number.isInteger(v.code)) return undefined;
  if (v.failures === null) return { code: v.code as number, failures: null };
  if (!Array.isArray(v.failures) || v.failures.length > MAX_FAILURES) return undefined;
  const failures: FailureId[] = [];
  for (const f of v.failures as unknown[]) {
    // Only the current shape: a legacy bare-string entry means a stale result, re-run the base.
    const o = f as { key?: unknown; text?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.key !== "string" || typeof o.text !== "string")
      return undefined;
    if (!o.key || o.key.length > MAX_KEY) return undefined;
    // The key is used as stored (re-normalizing it would break equality); text is re-sanitized.
    failures.push({ key: o.key, text: sanitizeFailure(o.text) });
  }
  return { code: v.code as number, failures };
}

/**
 * Base-commit check results for compare-mode gating. The base is the merge-base of the run's
 * trusted HEAD with the host's `refs/heads/<base>`: always a commit already on the base branch,
 * so nothing the agent commits can become "pre-existing". Each (project, base SHA, argv, parser,
 * lockfiles) runs at most once; results live host-side, never in a worktree.
 */
export function baselineChecks(opts: BaselineChecksOptions): BaselinePort {
  const locks = new Map<string, Promise<unknown>>();
  const serialized = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => locks.get(key) === tail && locks.delete(key));
    return next;
  };
  const resultsAt = async (
    ctx: PhaseContext,
    gitDir: string,
    baseSha: string,
    checks: CheckCommand[],
  ): Promise<(BaselineRun | { error: string })[]> => {
    const tree = await git(gitDir, ["ls-tree", "-r", baseSha]);
    const lockHash = createHash("sha256")
      .update(
        tree
          .split("\n")
          .filter((l) => LOCKFILE.test(l) && !l.includes("node_modules/"))
          .join("\n"),
      )
      .digest("hex");
    const dir = join(opts.root, "cache", safeSegment(ctx.project.id));
    // Stable argv (no per-run report token) + parser + lockfiles. CACHE_VERSION retires results
    // parsed from stdout before report files existed (e.g. a 13 MB eslint line cached as null).
    const keyOf = (c: CheckCommand) =>
      createHash("sha256")
        .update(
          JSON.stringify([
            CACHE_VERSION,
            ctx.project.id,
            baseSha,
            checkArgv(c),
            resolveParser(c),
            lockHash,
          ]),
        )
        .digest("hex");
    const cached = async (c: CheckCommand) =>
      validRun(
        JSON.parse(await readFile(join(dir, `${keyOf(c)}.json`), "utf8").catch(() => "null")),
      );
    return serialized(`${ctx.project.id}\u0000${baseSha}`, async () => {
      const results: (BaselineRun | { error: string })[] = [];
      const missing: number[] = [];
      for (const [i, c] of checks.entries()) {
        const hit = await cached(c).catch(() => undefined);
        if (hit) results[i] = hit;
        else missing.push(i);
      }
      if (!missing.length) return results;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const todo = missing.map((i) => checks[i] as CheckCommand);
      const fresh = await runOnBase(opts, ctx, gitDir, baseSha, todo);
      for (const [j, i] of missing.entries()) {
        const r = fresh[j] as BaselineRun | { error: string };
        results[i] = r;
        // Unusable results (no baseline, unparseable output) are retried next time, never cached.
        if ("error" in r || (r.code !== 0 && r.failures === null)) continue;
        const file = join(dir, `${keyOf(checks[i] as CheckCommand)}.json`);
        const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(tmp, JSON.stringify(r), { mode: 0o600 });
        await rename(tmp, file);
      }
      return results;
    });
  };
  const baseRef = async (ctx: PhaseContext) => {
    const gitDir = await commonDir(ctx.project.repoPath);
    const branch = ctx.project.baseBranch;
    await git(gitDir, ["check-ref-format", "--branch", branch]);
    return { gitDir, ref: `refs/heads/${branch}` };
  };
  return {
    defaultMode: (ctx) => (opts.compareByDefault(ctx) ? "compare" : "strict"),
    async run(ctx, checks) {
      const { gitDir, ref } = await baseRef(ctx);
      const head = await opts.headSha(ctx.workdir);
      if (!SHA.test(head)) throw new Error("invalid run HEAD");
      const baseSha = await git(gitDir, ["merge-base", ref, head]);
      if (!SHA.test(baseSha)) throw new Error("no merge-base with the base branch");
      // The base ref pointing at the run's own HEAD means it moved onto agent work: no baseline.
      if (baseSha === head)
        throw new Error("base branch points at the run HEAD; refusing baseline");
      return { baseSha, results: await resultsAt(ctx, gitDir, baseSha, checks) };
    },
    /** Ticket start: the run branch forks from the base tip, so that is the future merge-base. */
    async warm(ctx, checks) {
      try {
        const { gitDir, ref } = await baseRef(ctx);
        const baseSha = await git(gitDir, ["rev-parse", "--verify", `${ref}^{commit}`]);
        if (SHA.test(baseSha)) await resultsAt(ctx, gitDir, baseSha, checks);
      } catch {
        // best effort: the checks phase runs the base itself
      }
    },
    evidence: (ctx, record) => writeEvidence(opts.root, ctx, record),
  };
}

/** Runs checks in a fresh detached worktree at `baseSha` (same setup + sandbox), then removes it. */
async function runOnBase(
  opts: BaselineChecksOptions,
  ctx: PhaseContext,
  gitDir: string,
  baseSha: string,
  checks: CheckCommand[],
): Promise<(BaselineRun | { error: string })[]> {
  const parent = join(opts.root, "worktrees", safeSegment(ctx.project.id));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const workdir = join(parent, `${baseSha.slice(0, 12)}-${randomBytes(6).toString("hex")}`);
  await git(gitDir, ["worktree", "add", "--detach", "--", workdir, baseSha]);
  try {
    ctx.emit(`baseline: base commit ${baseSha.slice(0, 12)}`, "tool");
    const baseCtx: PhaseContext = { ...ctx, workdir };
    if (opts.setup) {
      const setup = await opts.setup(baseCtx, "checks").catch((e: unknown) => ({
        ok: false,
        summary: e instanceof Error ? e.message : "setup error",
      }));
      if (!setup.ok) {
        const error = `base setup failed: ${setup.summary.slice(0, 200)}`;
        return checks.map(() => ({ error }));
      }
    }
    const out: (BaselineRun | { error: string })[] = [];
    const roots = [workdir, await realpath(workdir).catch(() => workdir), "/work"];
    for (const check of checks) {
      const { res, run, ms } = await runCheck(opts.sandbox, baseCtx, check, {
        structured: true,
        workdir,
        roots,
        label: "baseline",
      });
      const env = environmentFailure(res.code, `${res.stdout}\n${res.stderr}`, ms);
      // A base run that could not really run (or timed out) is no baseline; never cached.
      if (env || res.code === 124) {
        out.push({ error: `base ${check.kind}: ${env ?? "timed out"}` });
        continue;
      }
      out.push(run);
    }
    return out;
  } finally {
    await git(gitDir, ["worktree", "remove", "--force", "--", workdir]).catch(async () => {
      await rm(workdir, { recursive: true, force: true });
      await git(gitDir, ["worktree", "prune"]).catch(() => undefined);
    });
  }
}

/**
 * Full failure lists of one gated check, host-side (never in a worktree):
 * `<root>/evidence/<project>/<ticket>/<run>-<index>-<kind>.json`. Returns the root-relative path.
 */
async function writeEvidence(
  root: string,
  ctx: PhaseContext,
  record: CheckEvidence,
): Promise<string> {
  const list = (v: string[]) => v.slice(0, MAX_FAILURES).map((f) => sanitizeFailure(f));
  const rel = join(
    "evidence",
    safeSegment(ctx.project.id),
    safeSegment(ctx.ticket.id),
    `${safeSegment(ctx.runId)}-${Math.floor(record.index)}-${safeSegment(record.kind)}.json`,
  );
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const body = {
    at: new Date().toISOString(),
    kind: record.kind,
    parser: record.parser,
    mode: record.mode,
    ...(record.baseSha ? { baseSha: record.baseSha } : {}),
    note: sanitizeFailure(record.note, 400),
    newFailures: list(record.newFailures),
    flaky: list(record.flaky),
    preExisting: list(record.preExisting),
  };
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(body, null, 1)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return rel;
}
