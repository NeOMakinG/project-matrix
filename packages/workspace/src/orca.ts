import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedWorkspace, Workspace, WorkspaceTarget } from "@matrix/core";
import {
  gitLocation,
  hostExecutor,
  type LineExecutor,
  runToCompletion,
  safeGitEnv,
  verifyWorktreeLink,
} from "@matrix/sandbox";
import { safeSegment } from "./native.js";
import { OrcaCli, record, str } from "./orca-cli.js";
import { gitdirFromCommonDir, TrustedWorktrees } from "./trusted.js";

/** The parts of Orca's CLI contract Matrix relies on (workspace + orchestration runtime). */
export const ORCA_REQUIRED_COMMANDS: Record<string, string[]> = {
  "worktree create": [
    "repo",
    "name",
    "base-branch",
    "json",
    "linear-issue",
    "no-parent",
    "setup",
    "comment",
  ],
  "worktree rm": ["worktree", "force", "json"],
  "repo list": ["json"],
  "terminal create": ["worktree", "command", "title", "json"],
  "terminal send": ["terminal", "text", "enter", "interrupt", "json"],
  "terminal close": ["terminal", "json"],
  "orchestration run-create": ["objective", "from", "json"],
  "orchestration task-create": ["task-title", "run", "from", "json"],
  "orchestration dispatch": ["task", "to", "from", "run", "json"],
  "orchestration check": ["terminal", "run", "ack", "types", "wait", "timeout-ms", "json"],
  "orchestration reply": ["id", "body", "run", "from", "json"],
  "orchestration send": ["type", "task-id", "dispatch-id", "outcome", "body", "subject", "json"],
  "orchestration worker-read": ["dispatch", "source", "json"],
};
export const ORCA_SCHEMA_VERSION = 1;

/** Linear identifiers (e.g. NEO-12); anything else is not passed to `--linear-issue`. */
const LINEAR_ID = /^[A-Z][A-Z0-9]{0,9}-[0-9]{1,9}$/;

export interface OrcaWorkspaceOptions {
  /** Shared Orca CLI client; built from `orcaBinary`/`executor`/`environment` when omitted. */
  cli?: OrcaCli;
  orcaBinary?: string;
  executor?: LineExecutor;
  environment?: string;
  /** Host git executor (tests). */
  gitExecutor?: LineExecutor;
  gitBinary?: string;
  /** Linear issue to link; defaults to the ticket id when it looks like a Linear identifier. */
  linearIssue?: (target: WorkspaceTarget) => string | undefined;
  /** Records each worktree's gitdir host-side (from the canonical repo) for WorktreeGitPort. */
  trusted?: TrustedWorktrees;
  /** Called before a worktree is removed (e.g. to close its Orca terminals). */
  beforeRemove?: (workdir: string) => Promise<void>;
}

/** What `prepared.ref` carries for an Orca worktree. */
export interface OrcaWorkspaceRef {
  orca: string;
  commonDir: string;
  branch: string;
}

export function parseOrcaRef(ref: string): OrcaWorkspaceRef {
  let value: Record<string, unknown> = {};
  try {
    value = record(JSON.parse(ref));
  } catch {}
  const orca = str(value.orca);
  const commonDir = str(value.commonDir);
  const branch = str(value.branch);
  if (!orca || !commonDir || !branch)
    throw new Error(
      "legacy or malformed Orca workspace ref; refusing to remove without an archive",
    );
  return { orca, commonDir, branch };
}

/** Validates an `orca agent-context --json` document against the contract above. Returns problems found. */
export function checkOrcaContract(context: unknown): string[] {
  const doc = record(context);
  const problems: string[] = [];
  if (doc.schemaVersion !== ORCA_SCHEMA_VERSION)
    problems.push(`unsupported schemaVersion ${String(doc.schemaVersion)}`);
  const commands = Array.isArray(doc.commands) ? doc.commands.map(record) : [];
  for (const [command, flags] of Object.entries(ORCA_REQUIRED_COMMANDS)) {
    const found = commands.find((c) => c.command === command);
    if (!found) {
      problems.push(`missing command: orca ${command}`);
      continue;
    }
    const available = new Set(Array.isArray(found.flags) ? found.flags : []);
    for (const flag of flags)
      if (!available.has(flag)) problems.push(`orca ${command} lacks --${flag}`);
  }
  return problems;
}

/** Ticket runs as Orca worktrees, so a human can watch or take over from Orca desktop/mobile. */
export class OrcaWorkspace implements Workspace {
  readonly kind = "orca" as const;
  readonly cli: OrcaCli;
  readonly #o: OrcaWorkspaceOptions;
  #validated = false;

  constructor(options: OrcaWorkspaceOptions = {}) {
    this.#o = options;
    this.cli =
      options.cli ??
      new OrcaCli({
        ...(options.orcaBinary ? { binary: options.orcaBinary } : {}),
        ...(options.executor ? { executor: options.executor } : {}),
        ...(options.environment ? { environment: options.environment } : {}),
      });
  }

  async #git(gitdir: string, args: string[]): Promise<string> {
    const result = await runToCompletion(this.#o.gitExecutor ?? hostExecutor, {
      cmd: [this.#o.gitBinary ?? "git", ...gitLocation(gitdir), ...args],
      cwd: gitdir,
      env: safeGitEnv(),
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0)
      throw new Error(`git ${args[0]} failed (${result.exitCode}): ${result.stderrTail.trim()}`);
    return result.stdout.trim();
  }

  async validate(): Promise<void> {
    if (this.#validated) return;
    const problems = checkOrcaContract(await this.cli.call(["agent-context", "--json"]));
    if (problems.length > 0) throw new Error(`Orca CLI contract mismatch: ${problems.join("; ")}`);
    this.#validated = true;
  }

  async repoId(repoPath: string): Promise<string> {
    const wanted = await realpath(repoPath);
    const result = record(await this.cli.call(["repo", "list", "--json"]));
    const repos = Array.isArray(result.repos) ? result.repos.map(record) : [];
    for (const repo of repos) {
      const path = typeof repo.path === "string" ? repo.path : "";
      if (path && (path === wanted || (await realpath(path).catch(() => path)) === wanted))
        return String(repo.id);
    }
    throw new Error(
      `repository ${repoPath} is not registered in Orca (run: orca repo add --path ${repoPath})`,
    );
  }

  async prepare(target: WorkspaceTarget): Promise<PreparedWorkspace> {
    await this.validate();
    const dotGit = join(target.repoPath, ".git");
    const stat = await lstat(dotGit);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`${target.repoPath} is not a canonical git repository`);
    const commonDir = await realpath(dotGit);
    const repo = await this.repoId(target.repoPath);
    // Orca sanitizes `/` out of names; the branch it returns is the one this run records.
    const name = safeSegment(target.branch.replace(/\//g, "-"));
    const args = [
      "worktree",
      "create",
      "--repo",
      `id:${repo}`,
      "--name",
      name,
      "--base-branch",
      target.baseBranch,
      "--no-parent",
      "--setup",
      "skip",
      "--comment",
      `Matrix ticket ${safeSegment(target.ticketId)}`,
      "--json",
    ];
    const linear = this.#o.linearIssue
      ? this.#o.linearIssue(target)
      : LINEAR_ID.test(target.ticketId)
        ? target.ticketId
        : undefined;
    if (linear && LINEAR_ID.test(linear)) args.push("--linear-issue", linear);
    const result = record(await this.cli.call(args));
    const worktree = record(result.worktree ?? result);
    const id = str(worktree.id);
    const path = str(worktree.path);
    const branch = str(worktree.branch)?.replace(/^refs\/heads\//, "");
    if (!id || !path || !branch) throw new Error("orca worktree create returned no id/path/branch");
    const workdir = await realpath(path);
    const gitdir = await gitdirFromCommonDir(commonDir, workdir);
    await verifyWorktreeLink(workdir, gitdir);
    const head = await this.#git(gitdir, ["symbolic-ref", "--short", "HEAD"]);
    if (head !== branch)
      throw new Error(`Orca worktree ${workdir} is on ${head}, expected ${branch}`);
    const baseSha = await this.#git(gitdir, ["rev-parse", "--verify", "HEAD^{commit}"]);
    await (this.#o.trusted ?? new TrustedWorktrees()).record(workdir, {
      gitdir,
      commonDir,
      baseSha,
    });
    const ref: OrcaWorkspaceRef = { orca: id, commonDir, branch };
    return { workdir, ref: JSON.stringify(ref) };
  }

  /**
   * `orca worktree rm --force` deletes the branch too, so the head is first pinned under
   * `refs/matrix/archive/<branch>-<sha12>` in the canonical repo. No archive, no removal.
   */
  async cleanup(prepared: PreparedWorkspace): Promise<void> {
    const ref = parseOrcaRef(prepared.ref);
    const gitdir = await gitdirFromCommonDir(ref.commonDir, prepared.workdir);
    await verifyWorktreeLink(prepared.workdir, gitdir);
    const head = await this.#git(gitdir, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error("unexpected HEAD while archiving");
    await this.#git(ref.commonDir, [
      "update-ref",
      `refs/matrix/archive/${safeSegment(ref.branch)}-${head.slice(0, 12)}`,
      head,
    ]);
    await this.#o.beforeRemove?.(prepared.workdir).catch(() => undefined);
    await this.cli.call(["worktree", "rm", "--worktree", `id:${ref.orca}`, "--force", "--json"]);
    await this.#o.trusted?.forget(prepared.workdir);
  }
}
