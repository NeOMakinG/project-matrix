import { realpath } from "node:fs/promises";
import type { PreparedWorkspace, Workspace, WorkspaceTarget } from "@matrix/core";
import { hostExecutor, type LineExecutor, runToCompletion } from "@matrix/sandbox";
import { safeSegment } from "./native.js";

/** The parts of Orca's CLI contract this adapter relies on. */
export const ORCA_REQUIRED_COMMANDS: Record<string, string[]> = {
  "worktree create": ["repo", "name", "base-branch", "json", "agent", "prompt", "issue"],
  "worktree rm": ["worktree", "force", "json"],
  "repo list": ["json"],
};
export const ORCA_SCHEMA_VERSION = 1;

export interface OrcaWorkspaceOptions {
  orcaBinary?: string;
  executor?: LineExecutor;
  /** Agent Orca starts in the worktree (e.g. claude, codex). Omit to let Matrix run agents itself. */
  agent?: string;
  prompt?: (target: WorkspaceTarget) => string | undefined;
  issue?: (target: WorkspaceTarget) => number | undefined;
  /** Orca runtime environment to target, e.g. the bosgame `orca serve` pairing. */
  environment?: string;
}

interface OrcaEnvelope {
  ok?: boolean;
  result?: unknown;
  error?: { message?: string } | string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Validates an `orca agent-context --json` document against the contract above. Returns problems found. */
export function checkOrcaContract(context: unknown): string[] {
  const doc = record(context);
  const problems: string[] = [];
  if (doc.schemaVersion !== ORCA_SCHEMA_VERSION) problems.push(`unsupported schemaVersion ${String(doc.schemaVersion)}`);
  const commands = Array.isArray(doc.commands) ? doc.commands.map(record) : [];
  for (const [command, flags] of Object.entries(ORCA_REQUIRED_COMMANDS)) {
    const found = commands.find((c) => c.command === command);
    if (!found) {
      problems.push(`missing command: orca ${command}`);
      continue;
    }
    const available = new Set(Array.isArray(found.flags) ? found.flags : []);
    for (const flag of flags) if (!available.has(flag)) problems.push(`orca ${command} lacks --${flag}`);
  }
  return problems;
}

/** Ticket runs as Orca worktrees, so a human can watch or take over from Orca. */
export class OrcaWorkspace implements Workspace {
  readonly kind = "orca" as const;
  readonly #o: OrcaWorkspaceOptions;
  #validated = false;

  constructor(options: OrcaWorkspaceOptions = {}) {
    this.#o = options;
  }

  async #orca(args: string[]): Promise<unknown> {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };
    const full = [...args];
    if (this.#o.environment) full.push("--environment", this.#o.environment);
    const result = await runToCompletion(this.#o.executor ?? hostExecutor, {
      cmd: [this.#o.orcaBinary ?? "orca", ...full],
      cwd: process.cwd(),
      env,
      timeoutMs: 120_000,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`orca ${args.slice(0, 2).join(" ")} returned non-JSON (exit ${result.exitCode}): ${result.stderrTail.trim().slice(-300)}`);
    }
    const envelope = record(parsed) as OrcaEnvelope;
    if (result.exitCode !== 0 || envelope.ok === false) {
      const message = typeof envelope.error === "string" ? envelope.error : envelope.error?.message;
      throw new Error(`orca ${args.slice(0, 2).join(" ")} failed: ${message ?? result.stderrTail.trim().slice(-300)}`);
    }
    return "result" in envelope ? envelope.result : parsed;
  }

  async validate(): Promise<void> {
    if (this.#validated) return;
    const context = await this.#orca(["agent-context", "--json"]);
    const problems = checkOrcaContract(context);
    if (problems.length > 0) throw new Error(`Orca CLI contract mismatch: ${problems.join("; ")}`);
    this.#validated = true;
  }

  async repoId(repoPath: string): Promise<string> {
    const wanted = await realpath(repoPath);
    const result = record(await this.#orca(["repo", "list", "--json"]));
    const repos = Array.isArray(result.repos) ? result.repos.map(record) : [];
    for (const repo of repos) {
      const path = typeof repo.path === "string" ? repo.path : "";
      if (path && (path === wanted || (await realpath(path).catch(() => path)) === wanted)) return String(repo.id);
    }
    throw new Error(`repository ${repoPath} is not registered in Orca (run: orca repo add --path ${repoPath})`);
  }

  async prepare(target: WorkspaceTarget): Promise<PreparedWorkspace> {
    await this.validate();
    const repo = await this.repoId(target.repoPath);
    const args = [
      "worktree",
      "create",
      "--repo",
      `id:${repo}`,
      "--name",
      safeSegment(target.branch.replace(/\//g, "-")),
      "--base-branch",
      target.baseBranch,
      "--json",
    ];
    if (this.#o.agent) {
      args.push("--agent", this.#o.agent);
      const prompt = this.#o.prompt?.(target);
      if (prompt) args.push("--prompt", prompt);
    }
    const issue = this.#o.issue?.(target);
    if (issue !== undefined) args.push("--issue", String(issue));
    const result = record(await this.#orca(args));
    const worktree = record(result.worktree ?? result);
    const id = typeof worktree.id === "string" ? worktree.id : undefined;
    const path = typeof worktree.path === "string" ? worktree.path : undefined;
    if (!id || !path) throw new Error("orca worktree create returned no id/path");
    return { workdir: path, ref: id };
  }

  async cleanup(prepared: PreparedWorkspace): Promise<void> {
    await this.#orca(["worktree", "rm", "--worktree", `id:${prepared.ref}`, "--force", "--json"]);
  }
}
