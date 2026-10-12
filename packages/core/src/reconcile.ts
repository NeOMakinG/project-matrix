import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TicketStatus, TicketStore } from "@matrix/tickets";
import type { EventBus } from "./bus.js";
import type { PhaseHandlers } from "./handlers.js";
import { isTrustedHoldout } from "./holdout.js";
import {
  advance,
  approve,
  autonomyFor,
  gate,
  reject,
  requiresApproval,
  type Transition,
} from "./machine.js";
import type { AutonomyMode, Phase, RunEvent, RunEventKind, Workspace } from "./ports.js";
import type { Authorization, GitPort, PhaseContext } from "./ports-internal.js";
import { type ApprovalRecord, type RunRecord, type Store, VersionConflictError } from "./store.js";
import type { BackoffPolicy, Limits, PhaseOutcome, ProjectConfig, WorkflowState } from "./types.js";

export interface ReconcilerOptions {
  store: Store;
  bus: EventBus;
  handlers: PhaseHandlers;
  workspace: Workspace;
  git: GitPort;
  tickets: (projectId: string) => TicketStore;
  limits: Limits;
  backoff: BackoffPolicy;
  host: string;
  /** Unique per process. Approvals requested by a reconciler can never be decided by it. */
  ownerId?: string;
  /** How long a workflow lease lasts without a heartbeat before another reconciler may take over. */
  leaseMs?: number;
  heartbeatMs?: number;
  scratchRoot?: string;
  clock?: () => Date;
  ids?: () => string;
}

interface ActiveRun {
  runId: string;
  projectId: string;
  ticketId: string;
  model: string;
  host: string;
  controller: AbortController;
  promise: Promise<void>;
}

export interface TickReport {
  dispatched: string[];
  replayed: string[];
  stalled: string[];
  awaitingApproval: string[];
  skipped: { ticketId: string; reason: string }[];
}

const TICKET_STATUS: Partial<Record<Phase, TicketStatus>> = {
  spike: "in_progress",
  implement: "in_progress",
  checks: "in_progress",
  review: "review",
  qa: "qa",
};

const IRREVERSIBLE = new Set<Phase>(["merge", "deploy"]);
const AFTER_REVIEW = new Set<Phase>(["qa", "merge", "deploy"]);

const hash = (...parts: (string | number)[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);

export function stepKey(w: WorkflowState): string {
  return hash(w.projectId, w.ticketId, w.phase, w.attempt, w.loops);
}

/** Merge and deploy keys ignore the attempt so a retried irreversible action dedupes downstream. */
export function actionKey(w: WorkflowState, headSha: string): string {
  return hash(w.projectId, w.ticketId, w.phase, w.loops, headSha);
}

export class Reconciler {
  readonly ownerId: string;
  private readonly active = new Map<string, ActiveRun>();
  private readonly clock: () => Date;
  private readonly ids: () => string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly scratchRoot: string;

  constructor(private readonly o: ReconcilerOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.ids = o.ids ?? randomUUID;
    this.ownerId = o.ownerId ?? `reconciler:${randomUUID().slice(0, 8)}`;
    if (!this.ownerId.startsWith("reconciler:"))
      throw new Error('ownerId must start with "reconciler:"');
    this.leaseMs = o.leaseMs ?? 60_000;
    this.heartbeatMs = o.heartbeatMs ?? Math.max(1_000, Math.floor(this.leaseMs / 3));
    this.scratchRoot = o.scratchRoot ?? join(tmpdir(), "matrix-scratch");
  }

  /** Waits for every in-flight run; used by tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((r) => r.promise));
    }
  }

  stop(): void {
    for (const run of this.active.values()) run.controller.abort(new Error("reconciler stopped"));
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = {
      dispatched: [],
      replayed: [],
      stalled: [],
      awaitingApproval: [],
      skipped: [],
    };
    await this.reapExpired(report);
    const projects = await this.o.store.listProjects();
    for (const project of projects) await this.syncReady(project);

    const now = this.clock();
    const pending = (await this.o.store.listWorkflows({ status: ["pending"] }))
      .filter((w) => !w.nextAttemptAt || w.nextAttemptAt <= now)
      .sort((a, b) => a.priority - b.priority);
    const byId = new Map(projects.map((p) => [p.id, p]));

    for (const w of pending) {
      const project = byId.get(w.projectId);
      if (!project) continue;
      if (this.isActive(w)) continue;
      const reason = await this.blockedBy(project, w);
      if (reason) {
        report.skipped.push({ ticketId: w.ticketId, reason });
        continue;
      }
      const result = await this.dispatch(project, w);
      if (result === "dispatched") report.dispatched.push(w.ticketId);
      else if (result === "replayed") report.replayed.push(w.ticketId);
      else if (result === "approval") report.awaitingApproval.push(w.ticketId);
    }
    return report;
  }

  private isActive(w: WorkflowState): boolean {
    return [...this.active.values()].some(
      (r) => r.projectId === w.projectId && r.ticketId === w.ticketId,
    );
  }

  private async syncReady(project: ProjectConfig): Promise<void> {
    const store = this.o.tickets(project.id);
    for (const t of await store.ready()) {
      await this.o.store.indexTicket(project.id, {
        id: t.id,
        title: t.title,
        status: t.status,
        labels: t.labels,
        ...(t.priority !== undefined ? { priority: t.priority } : {}),
        ...(t.url ? { url: t.url } : {}),
      });
      const created = await this.o.store.createWorkflow({
        projectId: project.id,
        ticketId: t.id,
        phase: "spike",
        status: "pending",
        attempt: 0,
        loops: 0,
        priority: t.priority ?? 2,
        version: 0,
      });
      if (created) {
        const w = await this.o.store.getWorkflow(project.id, t.id);
        if (w) this.o.bus.publish({ type: "workflow.changed", workflow: w });
      }
    }
  }

  private modelFor(project: ProjectConfig, phase: Phase): string {
    return (project.models[phase] ?? project.models.implement).model;
  }

  private async blockedBy(project: ProjectConfig, w: WorkflowState): Promise<string | null> {
    const runs = [...this.active.values()];
    const model = this.modelFor(project, w.phase);
    const { limits } = this.o;
    if (runs.filter((r) => r.projectId === project.id).length >= limits.perProject)
      return "project limit";
    if (
      runs.filter((r) => r.model === model).length >=
      (limits.perModel[model] ?? limits.defaultPerModel)
    ) {
      return `model limit ${model}`;
    }
    const hostLimit = limits.perHost[project.host] ?? limits.defaultPerHost;
    if (runs.filter((r) => r.host === project.host).length >= hostLimit)
      return `host limit ${project.host}`;
    if (project.dailyBudgetUsd !== undefined) {
      const spent = await this.o.store.getSpend(project.id, this.day());
      // Spend includes reservations for runs still in flight.
      if (
        spent + (project.estimatedRunUsd ?? 0) > project.dailyBudgetUsd ||
        spent >= project.dailyBudgetUsd
      ) {
        return "daily budget reached";
      }
    }
    return null;
  }

  private day(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  private async latestRun(w: WorkflowState, phase: Phase): Promise<RunRecord | undefined> {
    const runs = await this.o.store.listRuns({ projectId: w.projectId, ticketId: w.ticketId });
    return runs.filter((r) => r.phase === phase).at(-1);
  }

  /** The run whose result an approval covers: the QA run for merge, the merge run for deploy. */
  private async candidateRun(w: WorkflowState, phase: Phase): Promise<RunRecord | undefined> {
    return this.latestRun(w, phase === "merge" ? "qa" : "merge");
  }

  private async approvalFor(
    w: WorkflowState,
    phase: Phase,
    runId: string,
    headSha: string,
  ): Promise<{ approved?: ApprovalRecord | undefined; pending?: ApprovalRecord | undefined }> {
    const list = await this.o.store.listApprovals(w.projectId, w.ticketId, phase);
    const bound = list.filter((a) => a.runId === runId && a.headSha === headSha);
    return {
      approved: bound.filter((a) => a.status === "approved").at(-1),
      pending: list.filter((a) => a.status === "pending").at(-1),
    };
  }

  private async requestApproval(
    project: ProjectConfig,
    w: WorkflowState,
    phase: Phase,
  ): Promise<void> {
    if (!w.workdir) throw new Error("cannot request an approval without a workspace");
    const run = await this.candidateRun(w, phase);
    if (!run) throw new Error(`no ${phase === "merge" ? "qa" : "merge"} run to approve`);
    const headSha = await this.o.git.headSha(w.workdir);
    const approvalId = this.ids();
    await this.o.store.createApproval({
      id: approvalId,
      projectId: project.id,
      ticketId: w.ticketId,
      phase,
      runId: run.id,
      headSha,
      requestedBy: this.ownerId,
      status: "pending",
      requestedAt: this.clock(),
    });
    this.o.bus.publish({
      type: "approval.requested",
      approvalId,
      projectId: project.id,
      ticketId: w.ticketId,
      phase,
    });
  }

  /**
   * Gates for irreversible phases, evaluated against the *current* autonomy setting,
   * approvals bound to the run and commit, and the latest gate receipts.
   */
  async authorize(
    project: ProjectConfig,
    w: WorkflowState,
    phase: "merge" | "deploy",
  ): Promise<Authorization> {
    const fresh = (await this.o.store.getProject(project.id)) ?? project;
    const mode = autonomyFor(fresh, phase);
    if (!w.workdir) return { ok: false, reason: "no workspace", kind: "gates" };
    const headSha = await this.o.git.headSha(w.workdir);

    const problems = await this.gateProblems(fresh, w, phase);
    if (problems) return { ok: false, reason: problems, kind: "gates" };

    if (requiresApproval(mode, phase)) {
      const run = await this.candidateRun(w, phase);
      if (!run) return { ok: false, reason: `no run to approve for ${phase}`, kind: "gates" };
      const { approved } = await this.approvalFor(w, phase, run.id, headSha);
      if (!approved) {
        return {
          ok: false,
          reason: `${phase} requires an approval bound to ${headSha.slice(0, 12)}`,
          kind: "approval",
        };
      }
      return { ok: true, headSha, mode, approvalId: approved.id };
    }
    return { ok: true, headSha, mode };
  }

  /** Re-validates the receipts every earlier gate relied on. Failed or cancelled runs are never mergeable. */
  private async gateProblems(
    project: ProjectConfig,
    w: WorkflowState,
    phase: "merge" | "deploy",
  ): Promise<string | null> {
    const needed: Phase[] =
      phase === "merge" ? ["checks", "review", "qa"] : ["checks", "review", "qa", "merge"];
    for (const p of needed) {
      const run = await this.latestRun(w, p);
      if (!run) return `missing ${p} run`;
      if (run.status !== "ok") return `latest ${p} run is ${run.status}`;
      if (p === "merge") continue;
      const receipts = await this.o.store.listReceipts(run.id);
      if (p === "qa" && !receipts.some(isTrustedHoldout))
        return "QA has no judge-produced holdout score";
      const result = gate(p, { ok: true, summary: "", receipts }, project);
      if (!result.pass) return `${p} gate no longer passes: ${result.reason}`;
    }
    if (w.reviewedTree && w.workdir && (await this.o.git.treeState(w.workdir)) !== w.reviewedTree) {
      return "worktree changed after review";
    }
    return null;
  }

  private async dispatch(
    project: ProjectConfig,
    w: WorkflowState,
  ): Promise<"dispatched" | "replayed" | "approval" | "conflict" | "looped"> {
    const key = stepKey(w);
    const done = await this.o.store.getStep(key);
    if (done?.completedAt && done.output) {
      // Idempotency: this exact step already finished (crash before the transition was saved).
      await this.transition(project, w, done.output as PhaseOutcome);
      return "replayed";
    }

    // Any change to the tree after review invalidates checks and review.
    if (AFTER_REVIEW.has(w.phase) && w.reviewedTree && w.workdir) {
      if ((await this.o.git.treeState(w.workdir)) !== w.reviewedTree) {
        await this.loopTo(project, w, "checks", "worktree changed after review");
        return "looped";
      }
    }

    // Autonomy is re-read at every dispatch, not only when the phase was entered.
    if (IRREVERSIBLE.has(w.phase)) {
      const fresh = (await this.o.store.getProject(project.id)) ?? project;
      const mode = autonomyFor(fresh, w.phase);
      if (requiresApproval(mode, w.phase) && w.workdir) {
        const run = await this.candidateRun(w, w.phase);
        const headSha = await this.o.git.headSha(w.workdir);
        const { approved, pending } = run
          ? await this.approvalFor(w, w.phase, run.id, headSha)
          : {};
        if (!approved) {
          try {
            const saved = await this.o.store.saveWorkflow({ ...w, status: "waiting_approval" });
            if (!pending || pending.runId !== run?.id || pending.headSha !== headSha) {
              await this.requestApproval(project, saved, w.phase);
            }
            this.o.bus.publish({ type: "workflow.changed", workflow: saved });
          } catch (error) {
            if (error instanceof VersionConflictError) return "conflict";
            throw error;
          }
          return "approval";
        }
      }
    }

    const runId = this.ids();
    const now = this.clock();
    let state: WorkflowState;
    try {
      // The version check makes lease acquisition atomic across reconcilers.
      state = await this.o.store.saveWorkflow({
        ...w,
        status: "running",
        currentRunId: runId,
        leaseOwner: this.ownerId,
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
      });
    } catch (error) {
      if (error instanceof VersionConflictError) return "conflict";
      throw error;
    }

    const model = this.modelFor(project, w.phase);
    await this.o.store.createRun({
      id: runId,
      projectId: project.id,
      ticketId: w.ticketId,
      phase: w.phase,
      attempt: w.attempt,
      stepKey: key,
      model,
      host: project.host,
      ownerId: this.ownerId,
      status: "running",
      startedAt: now,
      lastEventAt: now,
      heartbeatAt: now,
    });
    await this.o.store.startStep({
      key,
      runId,
      phase: w.phase,
      input: { ticketId: w.ticketId, attempt: w.attempt, loops: w.loops, model },
    });
    const reserved = project.estimatedRunUsd ?? 0;
    if (reserved > 0) await this.o.store.addSpend(project.id, this.day(), reserved);
    this.o.bus.publish({
      type: "run.started",
      runId,
      projectId: project.id,
      ticketId: w.ticketId,
      phase: w.phase,
      model,
    });
    this.o.bus.publish({ type: "workflow.changed", workflow: state });

    const controller = new AbortController();
    const promise = this.execute(project, state, runId, key, controller, reserved).finally(() =>
      this.active.delete(runId),
    );
    this.active.set(runId, {
      runId,
      projectId: project.id,
      ticketId: w.ticketId,
      model,
      host: project.host,
      controller,
      promise,
    });
    return "dispatched";
  }

  private async loopTo(
    project: ProjectConfig,
    w: WorkflowState,
    phase: Phase,
    reason: string,
  ): Promise<void> {
    const loops = w.loops + 1;
    const next: WorkflowState =
      loops > project.maxLoops
        ? { ...w, loops, status: "blocked", lastError: `loop limit: ${reason}` }
        : { ...w, loops, phase, attempt: 0, status: "pending", lastError: reason };
    delete next.reviewedTree;
    const saved = await this.o.store.saveWorkflow(next);
    const effects: Transition["effects"] =
      saved.status === "blocked" ? [{ type: "blocked", reason: saved.lastError ?? reason }] : [];
    await this.applyEffects(project, saved, { state: saved, effects });
  }

  private owns(w: WorkflowState | null, runId: string): w is WorkflowState {
    return (
      !!w && w.status === "running" && w.currentRunId === runId && w.leaseOwner === this.ownerId
    );
  }

  private async heartbeat(
    projectId: string,
    ticketId: string,
    runId: string,
    controller: AbortController,
  ) {
    const w = await this.o.store.getWorkflow(projectId, ticketId);
    if (!this.owns(w, runId)) {
      controller.abort(new Error("lease lost to another reconciler"));
      return;
    }
    const now = this.clock();
    try {
      await this.o.store.saveWorkflow({
        ...w,
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
      });
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
    }
    await this.o.store.updateRun(runId, { heartbeatAt: now });
  }

  private async execute(
    project: ProjectConfig,
    w: WorkflowState,
    runId: string,
    key: string,
    controller: AbortController,
    reserved: number,
  ): Promise<void> {
    const timer = setInterval(() => {
      void this.heartbeat(project.id, w.ticketId, runId, controller).catch(() => undefined);
    }, this.heartbeatMs);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(project.runTimeoutMs)]);
    const scratch: string[] = [];
    let outcome: PhaseOutcome;
    try {
      const tickets = this.o.tickets(project.id);
      const ticket = await tickets.get(w.ticketId);
      if (!ticket) throw new Error(`ticket ${w.ticketId} not found`);
      const branch = `matrix/${w.ticketId}`;
      if (!w.workdir) {
        const prepared = await this.o.workspace.prepare({
          projectId: project.id,
          ticketId: w.ticketId,
          repoPath: project.repoPath,
          branch,
          baseBranch: project.baseBranch,
        });
        w = await this.saveOwned(project.id, w.ticketId, runId, (cur) => ({
          ...cur,
          workdir: prepared.workdir,
          workspaceRef: prepared.ref,
        }));
      }
      const workdir = w.workdir as string;
      const status = TICKET_STATUS[w.phase];
      if (status)
        await tickets.update(w.ticketId, { status, phase: w.phase }).catch(() => undefined);
      const idempotencyKey = IRREVERSIBLE.has(w.phase)
        ? actionKey(w, await this.o.git.headSha(workdir))
        : key;
      const current = w;
      const ctx: PhaseContext = {
        project,
        workflow: current,
        ticket,
        tickets,
        runId,
        workdir,
        branch,
        idempotencyKey,
        signal,
        emit: (message, kind = "log", data) => void this.record(runId, kind, message, data),
        scratchDir: async () => {
          await mkdir(this.scratchRoot, { recursive: true, mode: 0o700 });
          const dir = await mkdtemp(join(this.scratchRoot, `${runId}-`));
          scratch.push(dir);
          return dir;
        },
        authorize: async (phase) => {
          const latest = await this.o.store.getWorkflow(project.id, current.ticketId);
          if (!this.owns(latest, runId)) return { ok: false, reason: "lease lost", kind: "gates" };
          return this.authorize(project, latest, phase);
        },
      };
      outcome = await this.o.handlers[w.phase](ctx);
      if (signal.aborted) {
        outcome = {
          ok: false,
          summary: String((signal.reason as Error | undefined)?.message ?? "aborted"),
          receipts: outcome.receipts,
          runStatus: "timeout",
        };
      }
    } catch (error) {
      outcome = {
        ok: false,
        summary: (error as Error).message,
        receipts: [],
        runStatus: signal.aborted ? "timeout" : "failed",
      };
    } finally {
      clearInterval(timer);
      await Promise.all(
        scratch.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)),
      );
    }

    // Fencing: only the lease holder of this exact run may record a step result or move the workflow.
    const latest = await this.o.store.getWorkflow(project.id, w.ticketId);
    const fenced = !this.owns(latest, runId);
    await this.finish(project, runId, key, outcome, reserved, fenced);
    if (!fenced) await this.transition(project, latest as WorkflowState, outcome);
  }

  private async saveOwned(
    projectId: string,
    ticketId: string,
    runId: string,
    update: (current: WorkflowState) => WorkflowState,
  ): Promise<WorkflowState> {
    for (let i = 0; i < 5; i++) {
      const current = await this.o.store.getWorkflow(projectId, ticketId);
      if (!this.owns(current, runId)) throw new Error("lease lost");
      try {
        return await this.o.store.saveWorkflow(update(current));
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
      }
    }
    throw new VersionConflictError(projectId, ticketId);
  }

  private async record(
    runId: string,
    kind: RunEventKind,
    message: string,
    data?: unknown,
  ): Promise<void> {
    const event: RunEvent = {
      runId,
      at: this.clock().toISOString(),
      kind,
      message,
      ...(data !== undefined ? { data } : {}),
    };
    await this.o.store.appendEvent(event);
    await this.o.store.updateRun(runId, { lastEventAt: this.clock() });
    this.o.bus.publish({ type: "run.event", event });
  }

  private async finish(
    project: ProjectConfig,
    runId: string,
    key: string,
    outcome: PhaseOutcome,
    reserved: number,
    fenced: boolean,
  ): Promise<void> {
    const status = fenced
      ? "cancelled"
      : outcome.runStatus && outcome.runStatus !== "ok"
        ? outcome.runStatus
        : outcome.ok
          ? "ok"
          : "failed";
    await this.o.store.updateRun(runId, {
      status,
      summary: fenced ? `fenced (lease lost): ${outcome.summary}` : outcome.summary,
      finishedAt: this.clock(),
      ...(outcome.runner ? { runner: outcome.runner } : {}),
      ...(outcome.model ? { model: outcome.model } : {}),
      ...(outcome.tokens
        ? { inputTokens: outcome.tokens.input, outputTokens: outcome.tokens.output }
        : {}),
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
    });
    await this.o.store.addReceipts(runId, outcome.receipts);
    // Crashed or fenced runs are not recorded as completed steps, so they are retried, never replayed.
    if (!fenced && (!outcome.runStatus || outcome.runStatus === "ok")) {
      await this.o.store.completeStep(key, {
        output: outcome,
        ok: outcome.ok,
        completedAt: this.clock(),
        ...(outcome.model ? { model: outcome.model } : {}),
        ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
      });
    }
    // Settle the reservation against what the run actually cost (spend counts even when fenced).
    const delta = (outcome.costUsd ?? 0) - reserved;
    if (delta !== 0) await this.o.store.addSpend(project.id, this.day(), delta);
    this.o.bus.publish({
      type: "run.finished",
      runId,
      status,
      summary: outcome.summary,
      receipts: outcome.receipts,
    });
  }

  private async transition(
    project: ProjectConfig,
    w: WorkflowState,
    outcome: PhaseOutcome,
  ): Promise<void> {
    const t = advance(w, outcome, project, this.o.backoff, this.clock());
    const next: WorkflowState = { ...t.state };
    if (w.phase === "review" && next.phase === "qa" && next.workdir) {
      next.reviewedTree = await this.o.git.treeState(next.workdir);
    } else if (next.phase === "implement" || next.phase === "checks" || next.phase === "review") {
      delete next.reviewedTree;
    }
    if (next.status !== "running") {
      delete next.leaseOwner;
      delete next.leaseExpiresAt;
    }
    const saved = await this.o.store.saveWorkflow(next);
    await this.applyEffects(project, saved, { ...t, state: saved });
  }

  private async applyEffects(
    project: ProjectConfig,
    saved: WorkflowState,
    t: Transition,
  ): Promise<void> {
    this.o.bus.publish({ type: "workflow.changed", workflow: saved });
    const tickets = this.o.tickets(project.id);
    for (const effect of t.effects) {
      if (effect.type === "request_approval") {
        await this.requestApproval(project, saved, effect.phase);
      } else if (effect.type === "blocked") {
        await tickets.update(saved.ticketId, { status: "blocked" }).catch(() => undefined);
        await tickets
          .comment(saved.ticketId, `Matrix blocked this ticket: ${effect.reason}`)
          .catch(() => undefined);
        this.o.bus.publish({
          type: "workflow.blocked",
          projectId: project.id,
          ticketId: saved.ticketId,
          reason: effect.reason,
        });
      } else if (effect.type === "done") {
        await tickets.update(saved.ticketId, { status: "done" }).catch(() => undefined);
        if (saved.workspaceRef && saved.workdir) {
          await this.o.workspace
            .cleanup({ workdir: saved.workdir, ref: saved.workspaceRef })
            .catch(() => undefined);
        }
      }
    }
  }

  /** Takes over workflows whose lease expired (owner crashed or lost its heartbeat). */
  private async reapExpired(report: TickReport): Promise<void> {
    const now = this.clock();
    for (const w of await this.o.store.listWorkflows({ status: ["running"] })) {
      if (this.isActive(w)) continue;
      if (w.leaseExpiresAt && w.leaseExpiresAt > now) continue; // a live owner elsewhere
      const project = await this.o.store.getProject(w.projectId);
      if (!project) continue;
      if (w.currentRunId) {
        await this.o.store.updateRun(w.currentRunId, {
          status: "stalled",
          finishedAt: now,
          summary: "lease expired",
        });
      }
      try {
        await this.transition(project, w, {
          ok: false,
          summary: "run lease expired",
          receipts: [],
          runStatus: "timeout",
        });
        report.stalled.push(w.ticketId);
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
      }
    }
  }

  async decideApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    by: string,
    note?: string,
  ): Promise<WorkflowState> {
    const approval = await this.o.store.getApproval(approvalId);
    if (!approval) throw new Error(`approval ${approvalId} not found`);
    if (by === approval.requestedBy || by.startsWith("reconciler:")) {
      throw new Error("an approval cannot be decided by the identity that requested it");
    }
    const runs = await this.o.store.listRuns({
      projectId: approval.projectId,
      ticketId: approval.ticketId,
    });
    const run = runs.find((r) => r.id === approval.runId);
    if (run && by === run.ownerId)
      throw new Error("an approval cannot be decided by the run's initiator");

    const w = await this.o.store.getWorkflow(approval.projectId, approval.ticketId);
    if (!w || w.status !== "waiting_approval" || w.phase !== approval.phase) {
      throw new Error("workflow is no longer waiting for this approval");
    }
    if (decision === "approved") {
      if (!run || run.status !== "ok") throw new Error("the approved run did not succeed");
      if (w.workdir && (await this.o.git.headSha(w.workdir)) !== approval.headSha) {
        throw new Error("HEAD moved since the approval was requested; request a new approval");
      }
    }
    const decided = await this.o.store.decideApproval(approvalId, decision, by, note);
    this.o.bus.publish({
      type: "approval.decided",
      approvalId,
      status: decided.status as "approved" | "rejected",
    });
    const project = await this.o.store.getProject(approval.projectId);
    if (!project) throw new Error(`project ${approval.projectId} not found`);
    if (decision === "approved") {
      const saved = await this.o.store.saveWorkflow(approve(w));
      this.o.bus.publish({ type: "workflow.changed", workflow: saved });
      return saved;
    }
    const t = reject(w, project, note ?? "rejected");
    const saved = await this.o.store.saveWorkflow(t.state);
    await this.applyEffects(project, saved, { ...t, state: saved });
    return saved;
  }

  async setAutonomy(
    projectId: string,
    phase: Phase | "default",
    mode: AutonomyMode,
    actor: string,
    reason?: string,
  ): Promise<void> {
    await this.o.store.setAutonomy({
      projectId,
      phase,
      mode,
      actor,
      at: this.clock(),
      ...(reason ? { reason } : {}),
    });
    this.o.bus.publish({ type: "autonomy.changed", projectId, phase, mode });
  }
}
