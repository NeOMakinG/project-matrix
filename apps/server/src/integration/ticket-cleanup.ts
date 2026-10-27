import type { WorkflowState } from "@matrix/core";

/**
 * Removes a ticket's run worktree, Orca terminals and sandbox once its PR is MERGED or CLOSED on
 * GitHub. Never on an open PR, never with uncommitted or unpushed work, never `--force`, never a
 * branch deletion. Every skip is logged; a second sweep after a clean one is a no-op.
 */

export type PrState = "MERGED" | "CLOSED" | "OPEN";

export interface PrInfo {
  state: PrState;
  headRefOid?: string;
  url?: string;
  /** Epoch ms GitHub closed (or merged) the PR. */
  closedAt?: number;
}

export interface OrcaTerminalRow {
  handle: string;
  worktreePath?: string;
  /** Epoch ms of the last output, null when the terminal never printed. */
  lastOutputAt?: number | null;
}

export interface GitResult {
  exitCode: number;
  stdout: string;
}

export interface TicketCleanupPorts {
  /** Workflows to consider (any status; filtered here). */
  workflows(): Promise<WorkflowState[]>;
  getWorkflow(projectId: string, ticketId: string): Promise<WorkflowState | null>;
  /** Clears workdir/workspaceRef with an optimistic version check; false on conflict. */
  clearWorkdir(w: WorkflowState): Promise<boolean>;
  /** GitHub state of the ticket's recorded PR; undefined when Matrix never opened one. */
  prState(projectId: string, ticketId: string): Promise<PrInfo | undefined>;
  /** Trusted (host-recorded) git location of a ticket worktree; undefined if unknown. */
  trusted(workdir: string): Promise<{ gitdir: string; commonDir: string } | undefined>;
  exists(path: string): Promise<boolean>;
  /** Host git (argv only); `gitdir`/`workTree` passed as --git-dir/--work-tree. */
  git(gitdir: string, workTree: string | undefined, args: string[]): Promise<GitResult>;
  terminals(workdir: string): Promise<OrcaTerminalRow[]>;
  closeTerminal(handle: string): Promise<void>;
  /** Terminal handles whose Matrix agent process is known to have exited (phase evidence). */
  finishedTerminals(workdir: string): Promise<Set<string>>;
  /** Stops containers labelled with exactly this project AND ticket. Returns how many. */
  stopSandbox(target: { projectId: string; ticketId: string }): Promise<number>;
  /** Drops host registries for the worktree (trusted map, Orca run memory, live session). */
  forget(workdir: string): Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface CleanupAction {
  projectId: string;
  ticketId: string;
  workdir: string;
  outcome: "cleaned" | "would_clean" | "kept" | "skipped";
  reason: string;
  terminals?: string[];
  containers?: number;
}

/** Workflow statuses the reconciler will not pick up on its own (never running or pending). */
export const CLEANUP_STATUSES: ReadonlySet<WorkflowState["status"]> = new Set([
  "waiting_approval",
  "blocked",
  "done",
]);

export const RECENT_OUTPUT_MS = 10 * 60_000;
/** A merged/closed PR settles this long first, so Matrix's own merge/done path runs before us. */
export const SETTLE_MS = 30 * 60_000;

/** `git status --porcelain` lines that are real changes (.DS_Store noise ignored). */
export function dirtyEntries(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const path = line.slice(3).replace(/^"|"$/g, "");
      const target = path.includes(" -> ") ? (path.split(" -> ").pop() ?? path) : path;
      return target.split("/").pop() !== ".DS_Store";
    });
}

/** True when a terminal must be left alone: recent output and no known-finished agent. */
export function terminalBusy(
  t: OrcaTerminalRow,
  now: number,
  finished: ReadonlySet<string>,
): boolean {
  if (finished.has(t.handle)) return false;
  return typeof t.lastOutputAt === "number" && now - t.lastOutputAt < RECENT_OUTPUT_MS;
}

export class TicketCleanup {
  readonly #p: TicketCleanupPorts;
  #running: Promise<CleanupAction[]> | undefined;

  constructor(ports: TicketCleanupPorts) {
    this.#p = ports;
  }

  /** One pass over every candidate. Concurrent calls share the pass in flight. */
  sweep(opts: { dryRun?: boolean } = {}): Promise<CleanupAction[]> {
    this.#running ??= this.#sweep(opts.dryRun === true).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #sweep(dryRun: boolean): Promise<CleanupAction[]> {
    const actions: CleanupAction[] = [];
    for (const w of await this.#p.workflows()) {
      if (!w.workdir || !CLEANUP_STATUSES.has(w.status)) continue;
      let action: CleanupAction;
      try {
        action = await this.#one(w, w.workdir, dryRun);
      } catch (error) {
        action = this.#act(w, w.workdir, "skipped", `error: ${(error as Error).message}`);
      }
      actions.push(action);
      this.#p.log?.(
        `ticket-cleanup ${w.ticketId}: ${action.outcome} (${action.reason})${
          action.terminals?.length ? ` terminals=${action.terminals.length}` : ""
        }${action.containers ? ` containers=${action.containers}` : ""}`,
      );
    }
    return actions;
  }

  #act(
    w: WorkflowState,
    workdir: string,
    outcome: CleanupAction["outcome"],
    reason: string,
    extra: Partial<CleanupAction> = {},
  ): CleanupAction {
    return { projectId: w.projectId, ticketId: w.ticketId, workdir, outcome, reason, ...extra };
  }

  async #one(w: WorkflowState, workdir: string, dryRun: boolean): Promise<CleanupAction> {
    const p = this.#p;
    const pr = await p.prState(w.projectId, w.ticketId);
    if (!pr) return this.#act(w, workdir, "kept", "no pull request recorded");
    if (pr.state !== "MERGED" && pr.state !== "CLOSED")
      return this.#act(w, workdir, "kept", `PR ${pr.state.toLowerCase()}`);
    // A merged PR on a ticket still waiting in Matrix is finished by Matrix's own merge step
    // (auto-merge or approval -> done); it is swept once done. A closed one never progresses.
    if (w.status === "waiting_approval" && pr.state === "MERGED")
      return this.#act(w, workdir, "kept", "PR merged; waiting for Matrix to mark it done");
    const now = (p.now ?? Date.now)();
    if (pr.closedAt === undefined || now - pr.closedAt < SETTLE_MS)
      return this.#act(w, workdir, "kept", `PR ${pr.state.toLowerCase()} < 30 min ago`);

    const trusted = await p.trusted(workdir);
    const present = await p.exists(workdir);
    if (present && !trusted)
      return this.#act(w, workdir, "skipped", "worktree not in the trusted registry");

    if (present && trusted) {
      const status = await p.git(trusted.gitdir, workdir, ["status", "--porcelain"]);
      if (status.exitCode !== 0) return this.#act(w, workdir, "skipped", "git status failed");
      const dirty = dirtyEntries(status.stdout);
      if (dirty.length > 0)
        return this.#act(w, workdir, "skipped", `uncommitted changes (${dirty.length})`);
      const head = await p.git(trusted.gitdir, workdir, ["rev-parse", "--verify", "HEAD^{commit}"]);
      if (head.exitCode !== 0) return this.#act(w, workdir, "skipped", "cannot resolve HEAD");
      const sha = head.stdout.trim();
      if (sha !== pr.headRefOid) {
        const local = await p.git(trusted.gitdir, workdir, [
          "rev-list",
          "--max-count=1",
          "HEAD",
          "--not",
          "--remotes",
        ]);
        if (local.exitCode !== 0 || local.stdout.trim().length > 0)
          return this.#act(w, workdir, "skipped", "commits not on any remote");
      }
    }

    const terminals = (await p.terminals(workdir)).filter((t) => t.worktreePath === workdir);
    const finished = await p.finishedTerminals(workdir);
    const busy = terminals.filter((t) => terminalBusy(t, now, finished));
    if (busy.length > 0)
      return this.#act(w, workdir, "skipped", `terminal output < 10 min (${busy.length})`);
    const handles = terminals.map((t) => t.handle);
    const reason = `PR ${pr.state.toLowerCase()}`;
    if (dryRun) return this.#act(w, workdir, "would_clean", reason, { terminals: handles });

    // Re-read: the reconciler may have picked the ticket up meanwhile.
    const latest = await p.getWorkflow(w.projectId, w.ticketId);
    if (
      !latest ||
      latest.version !== w.version ||
      latest.workdir !== workdir ||
      !CLEANUP_STATUSES.has(latest.status)
    )
      return this.#act(w, workdir, "skipped", "workflow changed during the sweep");

    // Claim first: once the workflow no longer points at this worktree, the reconciler will never
    // run in it again (a restart prepares a fresh one), so nothing can race the removal below.
    if (!(await p.clearWorkdir(latest)))
      return this.#act(w, workdir, "skipped", "workflow changed during the sweep");
    for (const handle of handles) await p.closeTerminal(handle);
    const containers = await p.stopSandbox({ projectId: w.projectId, ticketId: w.ticketId });
    if (present && trusted) {
      // No --force: git refuses on any change it would lose. The branch is kept.
      const removed = await p.git(trusted.commonDir, undefined, [
        "worktree",
        "remove",
        "--",
        workdir,
      ]);
      if (removed.exitCode !== 0)
        return this.#act(w, workdir, "skipped", "git worktree remove refused; left on disk", {
          terminals: handles,
          containers,
        });
    }
    if (trusted) await p.git(trusted.commonDir, undefined, ["worktree", "prune"]);
    await p.forget(workdir);
    return this.#act(w, workdir, "cleaned", reason, { terminals: handles, containers });
  }
}

/** The host side of the ports (git, Orca, sandbox, registries), provided by the runtime. */
export type CleanupHost = Pick<
  TicketCleanupPorts,
  | "trusted"
  | "exists"
  | "git"
  | "terminals"
  | "closeTerminal"
  | "finishedTerminals"
  | "stopSandbox"
  | "forget"
>;

/** Orca's `terminal list --json` result, reduced to what the sweep reads. */
export function parseTerminalList(result: unknown): OrcaTerminalRow[] {
  const rows =
    result &&
    typeof result === "object" &&
    Array.isArray((result as { terminals?: unknown }).terminals)
      ? ((result as { terminals: unknown[] }).terminals as Record<string, unknown>[])
      : [];
  return rows.flatMap((row) =>
    typeof row?.handle === "string" && /^term_[A-Za-z0-9-]{1,80}$/.test(row.handle)
      ? [
          {
            handle: row.handle,
            ...(typeof row.worktreePath === "string" ? { worktreePath: row.worktreePath } : {}),
            lastOutputAt: typeof row.lastOutputAt === "number" ? row.lastOutputAt : null,
          },
        ]
      : [],
  );
}

/** Terminal handles named in phase evidence (`<dataDir>/orca-evidence/*.json`) for a worktree. */
export function finishedFromEvidence(docs: unknown[], workdir: string): Set<string> {
  const out = new Set<string>();
  for (const doc of docs) {
    const d = doc as { run?: { worktree?: unknown; coordinator?: unknown }; terminal?: unknown };
    if (d?.run?.worktree !== workdir) continue;
    // Only dispatch terminals: their evidence is written after the agent process exited.
    if (typeof d.terminal === "string") out.add(d.terminal);
  }
  return out;
}
