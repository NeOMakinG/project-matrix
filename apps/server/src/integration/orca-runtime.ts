import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Receipt, RunRequest } from "@matrix/core";
import type { LineExecutor } from "@matrix/sandbox";
import {
  OrcaCli,
  type OrcaPhaseEvidence,
  type OrcaRunMemory,
  OrcaTicketSession,
  orcaLauncher,
  safeSegment,
  type TrustedWorktrees,
} from "@matrix/workspace";

export interface OrcaBridgeOptions {
  dataDir: string;
  binary?: string;
  environment?: string;
  /** Mailbox poll interval for the coordinator pump. */
  pollMs?: number;
  /** Test seam: Orca CLI executor. */
  cli?: OrcaCli;
  /**
   * True only for a ticket worktree this host prepared through Orca (the trusted registry).
   * Every other workdir (private QA scratch dirs, snapshots) is not an Orca workspace.
   */
  isTicketWorktree: (workdir: string) => Promise<boolean>;
}

/** Shape of `receipt.data.orca` on phase evidence; read by the tracker status comment. */
export interface OrcaReceiptData {
  run: string;
  dispatch: string;
  task: string;
  terminal: string;
  outcome: OrcaPhaseEvidence["outcome"];
}

export interface OrcaPhase {
  launcher: LineExecutor;
  /** Evidence receipts for this phase (call after the runner returned). */
  receipts(): Promise<Receipt[]>;
}

export interface OrcaRuntimeBridge {
  cli: OrcaCli;
  /**
   * Orca launch for a ticket-worktree call, or undefined for any other workdir: those run on
   * the native sandbox runner. Private QA (holdout scenario writer, probe planner, judge) runs
   * in host scratch dirs that Orca cannot target, and keeping it out of the ticket's Orca Run
   * also keeps holdout prompts out of Orca's tasks, terminals and the implementer's worktree.
   */
  phase(req: RunRequest): Promise<OrcaPhase | undefined>;
  /** Closes the ticket's coordinator terminal before its worktree is removed. */
  release(workdir: string): Promise<void>;
  /** release() plus the persisted worktree -> Run binding (cleanup after the worktree is gone). */
  forget(workdir: string): Promise<void>;
}

/** `isTicketWorktree` from the host's trusted registry (OrcaWorkspace.prepare records realpaths). */
export function trustedTicketWorktree(trusted: Pick<TrustedWorktrees, "lookup">) {
  return (workdir: string): Promise<boolean> =>
    trusted.lookup(workdir).then(
      () => true,
      () => false,
    );
}

/**
 * Host-private `worktree -> Orca Run id` map (`<dataDir>/orca-runs.json`, 0600), so a ticket's
 * retries and a server restart rebind to the ticket's existing Run instead of creating another.
 */
export function fileRunMemory(path: string): OrcaRunMemory {
  let chain: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<Record<string, string>> => {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  };
  const update = (change: (all: Record<string, string>) => void) => {
    const next = chain.then(async () => {
      const all = await load();
      change(all);
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, path);
    });
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    get: async (worktree) => {
      await chain;
      const id = (await load())[worktree];
      return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
    },
    set: (worktree, runId) =>
      update((all) => {
        all[worktree] = runId;
      }),
    delete: (worktree) =>
      update((all) => {
        delete all[worktree];
      }),
  };
}

/**
 * Glue between the Matrix runtime and Orca: one OrcaTicketSession (coordinator terminal + Run)
 * per ticket worktree, one Orca task/terminal/dispatch per runner call. Ids only, never ticket
 * text, go into Orca titles and objectives.
 */
export function orcaBridge(o: OrcaBridgeOptions): OrcaRuntimeBridge {
  // Scripts, stdin/exit files and the Podman env-file are host-local paths: a paired remote
  // runtime would run terminals on another machine where none of them exist.
  if (o.environment)
    throw new Error(
      "MATRIX_RUNTIME=orca drives the local Orca runtime only; unset MATRIX_ORCA_ENVIRONMENT",
    );
  const cli =
    o.cli ??
    new OrcaCli({
      ...(o.binary ? { binary: o.binary } : {}),
      ...(o.environment ? { environment: o.environment } : {}),
    });
  const sessions = new Map<string, OrcaTicketSession>();
  const memory = fileRunMemory(join(o.dataDir, "orca-runs.json"));
  let counter = 0;
  const sessionFor = (req: RunRequest) => {
    let session = sessions.get(req.workdir);
    if (!session) {
      session = new OrcaTicketSession(
        cli,
        req.workdir,
        `${safeSegment(req.ticketId)} · ${safeSegment(req.projectId)}`,
        o.pollMs,
        memory,
      );
      sessions.set(req.workdir, session);
    }
    return session;
  };
  return {
    cli,
    async phase(req) {
      if (!(await o.isTicketWorktree(req.workdir))) return undefined;
      let evidence: OrcaPhaseEvidence | undefined;
      const launcher = orcaLauncher({
        cli,
        session: sessionFor(req),
        scriptRoot: join(o.dataDir, "orca-scripts"),
        title: `${req.phase} · ${safeSegment(req.model)}`,
        onEvidence: (e) => {
          evidence = e;
        },
      });
      return {
        launcher,
        async receipts() {
          if (!evidence) return [];
          counter += 1;
          const dir = join(o.dataDir, "orca-evidence");
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const path = join(dir, `${safeSegment(req.runId)}-${counter}.json`);
          const body = `${JSON.stringify(evidence, null, 2)}\n`;
          await writeFile(path, body, { mode: 0o600 });
          const data: OrcaReceiptData = {
            run: evidence.run.runId,
            dispatch: evidence.dispatchId,
            task: evidence.taskId,
            terminal: evidence.terminal,
            outcome: evidence.outcome,
          };
          return [
            {
              kind: "log",
              ok: evidence.outcome === "succeeded",
              summary: `Orca ${data.run} dispatch ${data.dispatch}: ${data.outcome}`,
              path,
              sha256: createHash("sha256").update(body).digest("hex"),
              data: { orca: data },
            },
          ];
        },
      };
    },
    async release(workdir) {
      const session = sessions.get(workdir);
      sessions.delete(workdir);
      await session?.close();
    },
    async forget(workdir) {
      const session = sessions.get(workdir);
      sessions.delete(workdir);
      await session?.close().catch(() => undefined);
      await memory.delete(workdir);
    },
  };
}
