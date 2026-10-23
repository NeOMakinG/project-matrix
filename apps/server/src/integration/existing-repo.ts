import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import type { CheckCommand } from "@matrix/core";
import {
  gitLocation,
  hostExecutor,
  type LineExecutor,
  runToCompletion,
  safeGitEnv,
} from "@matrix/sandbox";
import { CoreError, type SetupStep } from "../core-port.js";

/** What the operator sends to register a repo that already exists on the host. */
export interface RepoRegistration {
  path: string;
  baseBranch: string;
  remote?: string;
}

/** A validated registration: real path, existing base branch, GitHub remote. */
export interface ResolvedRepo {
  path: string;
  baseBranch: string;
  remote: string;
  /** `owner/repo` of the remote on github.com (draft PRs are opened there). */
  github: string;
}

export interface RepoCheckOptions {
  gitBinary?: string;
  executor?: LineExecutor;
}

const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SLUG = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

const invalid = (message: string): never => {
  throw new CoreError("invalid_request", message);
};

/** `MATRIX_REPO_ROOTS`: colon-separated absolute directories; empty disables existing repos. */
export function parseRepoRoots(value: string | undefined): string[] {
  return (value ?? "")
    .split(":")
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => {
      if (!isAbsolute(root)) throw new Error(`MATRIX_REPO_ROOTS entries must be absolute: ${root}`);
      return root;
    });
}

export const validBranch = (name: string) => BRANCH.test(name) && !name.endsWith(".lock");

/** `owner/repo` for a github.com remote URL (https or ssh); anything else is undefined. */
export function githubSlug(url: string): string | undefined {
  const match =
    /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url);
  const slug = match?.[1];
  return slug && SLUG.test(slug) ? slug : undefined;
}

/** Host git on the canonical repo metadata, never discovered from a working tree. */
export async function repoGit(
  gitDir: string,
  args: string[],
  options: RepoCheckOptions = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runToCompletion(options.executor ?? hostExecutor, {
    cmd: [options.gitBinary ?? "git", ...gitLocation(gitDir), ...args],
    cwd: gitDir,
    env: safeGitEnv(),
    timeoutMs: 30_000,
  });
  return { ok: result.exitCode === 0, stdout: result.stdout.trim(), stderr: result.stderrTail };
}

async function within(path: string, roots: string[]): Promise<boolean> {
  for (const root of roots) {
    const real = await realpath(root).catch(() => undefined);
    if (real && (path === real || path.startsWith(real.endsWith(sep) ? real : real + sep)))
      return true;
  }
  return false;
}

/**
 * Validates an existing-repo registration: absolute path whose real location (symlinks resolved)
 * sits under an operator-allowed root, a canonical git repo (`.git` directory, not a symlink or
 * worktree pointer), an existing base branch and a github.com remote. Nothing is written.
 */
export async function resolveExistingRepo(
  input: RepoRegistration,
  roots: string[],
  registered: readonly string[],
  options: RepoCheckOptions = {},
): Promise<ResolvedRepo> {
  if (roots.length === 0)
    invalid("registering existing repos is disabled (set MATRIX_REPO_ROOTS on the server)");
  if (!isAbsolute(input.path) || /[\0\r\n]/.test(input.path))
    invalid("repo path must be an absolute path");
  const remote = input.remote ?? "origin";
  if (!REMOTE.test(remote)) invalid("invalid remote name");
  if (!validBranch(input.baseBranch)) invalid("invalid base branch name");
  const path = await realpath(input.path).catch(() => invalid("repo path does not exist"));
  if (!(await within(path, roots))) invalid("repo path is outside MATRIX_REPO_ROOTS");
  const dotGit = `${path}${sep}.git`;
  const stat = await lstat(dotGit).catch(() => invalid("repo path is not a git repository"));
  if (stat.isSymbolicLink() || !stat.isDirectory())
    invalid("repo must be a canonical git repository (.git directory, not a worktree)");
  for (const other of registered) {
    const real = await realpath(other).catch(() => other);
    if (real === path) throw new CoreError("conflict", "this repo is already registered");
  }
  const branch = await repoGit(
    dotGit,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${input.baseBranch}`],
    options,
  );
  if (!branch.ok) invalid(`base branch ${input.baseBranch} does not exist`);
  const url = await repoGit(dotGit, ["config", "--get", `remote.${remote}.url`], options);
  if (!url.ok || !url.stdout) invalid(`remote ${remote} is not configured`);
  const github = githubSlug(url.stdout);
  if (!github) invalid(`remote ${remote} is not a github.com repository`);
  return { path, baseBranch: input.baseBranch, remote, github: github as string };
}

const LOCKFILES: Array<[string, string]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];
const CHECK_SCRIPTS: Array<CheckCommand["kind"]> = ["typecheck", "lint", "test"];

/**
 * Safe default checks for an existing repo: the `typecheck`, `lint` and `test` scripts its
 * committed `package.json` (on the base branch) defines, run with the package manager its
 * lockfile names. Read from git objects, never from the working tree. No scripts: no checks.
 */
export async function detectChecks(
  repo: Pick<ResolvedRepo, "path" | "baseBranch">,
  options: RepoCheckOptions = {},
): Promise<CheckCommand[]> {
  const gitDir = `${repo.path}${sep}.git`;
  const at = (file: string) => `refs/heads/${repo.baseBranch}:${file}`;
  const manifest = await repoGit(gitDir, ["cat-file", "blob", at("package.json")], options);
  if (!manifest.ok || manifest.stdout.length > 256 * 1024) return [];
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(manifest.stdout) as { scripts?: unknown };
    if (parsed.scripts && typeof parsed.scripts === "object")
      scripts = parsed.scripts as Record<string, unknown>;
  } catch {
    return [];
  }
  let manager = "npm";
  for (const [file, pm] of LOCKFILES) {
    if ((await repoGit(gitDir, ["cat-file", "-e", at(file)], options)).ok) {
      manager = pm;
      break;
    }
  }
  return CHECK_SCRIPTS.filter((kind) => typeof scripts[kind] === "string").map((kind) => ({
    kind,
    cmd: [manager, "run", kind],
  }));
}

/** Top-level files agents may edit by default (manifests and tool configs). */
const DEFAULT_EDITABLE_FILES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vitest.config.ts",
  "biome.json",
  "eslint.config.js",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
]);
/** Root-level docs (README.md, SPECS.md, CHANGELOG.md, ...) are editable by default. */
const DOC_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.md$/i;
const EDITABLE = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

/**
 * Paths agents may change in an existing repo. Relative, no `..`, and no segment starting with
 * `.`: dot paths (`.github/workflows`, `.env`, `.matrix`) stay denied whatever the list says.
 */
export function validateEditablePaths(paths: string[]): string[] {
  if (paths.length === 0 || paths.length > 100) invalid("editablePaths needs 1 to 100 entries");
  for (const path of paths)
    if (path.length > 200 || !EDITABLE.test(path) || path.split("/").includes(".."))
      invalid(`invalid editable path: ${JSON.stringify(path)} (relative, no dot segments)`);
  return [...new Set(paths)];
}

/**
 * Default editable paths of an existing repo: every tracked top-level directory on the base branch
 * except dot directories (`.git`, `.github`, `.matrix`, ...), plus the usual top-level manifests and
 * root-level Markdown docs (`README.md`, `SPECS.md`, `CHANGELOG.md`).
 */
export async function defaultEditablePaths(
  repo: Pick<ResolvedRepo, "path" | "baseBranch">,
  options: RepoCheckOptions = {},
): Promise<string[]> {
  const listed = await repoGit(
    `${repo.path}${sep}.git`,
    ["ls-tree", "-z", `refs/heads/${repo.baseBranch}`],
    options,
  );
  if (!listed.ok) invalid("cannot list the base branch");
  const out: string[] = [];
  for (const record of listed.stdout.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const type = record.slice(0, tab).split(" ")[1];
    const name = record.slice(tab + 1);
    if (name.startsWith(".") || !EDITABLE.test(name)) continue;
    if (
      type === "tree" ||
      (type === "blob" && (DEFAULT_EDITABLE_FILES.has(name) || DOC_FILE.test(name)))
    )
      out.push(name);
  }
  return out;
}

export type { SetupStep };

const SETUP_CWD = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const SETUP_ARG = /^[^\0\r\n]{1,200}$/;

/**
 * Operator-set setup steps for an existing repo: at most 10, relative non-dot `cwd`, argv only.
 * An empty list disables dependency setup (no lockfile detection).
 */
export function validateSetup(steps: SetupStep[]): SetupStep[] {
  if (steps.length > 10) invalid("setup accepts at most 10 steps");
  return steps.map((step) => {
    const cwd = step.cwd === undefined || step.cwd === "." ? undefined : step.cwd;
    if (cwd !== undefined && (cwd.length > 200 || !SETUP_CWD.test(cwd)))
      invalid(`invalid setup cwd: ${JSON.stringify(step.cwd)} (relative, no dot segments)`);
    if (step.run.length === 0 || step.run.length > 30 || !step.run.every((a) => SETUP_ARG.test(a)))
      invalid("setup run must be 1 to 30 argv entries without NUL or newlines");
    return { ...(cwd ? { cwd } : {}), run: [...step.run] };
  });
}
