import { createHash, randomUUID } from "node:crypto";
import type { TicketStatus, TicketStore } from "@matrix/tickets";
import type { EventBus } from "./bus.js";
import type { PhaseHandlers } from "./handlers.js";
import { advance, approve, reject, type Transition } from "./machine.js";
import type { AutonomyMode, Phase, RunEvent, RunEventKind, Workspace } from "./ports.js";
import type { PhaseContext } from "./ports-internal.js";
import { type Store, VersionConflictError } from "./store.js";
import type { BackoffPolicy, Limits, PhaseOutcome, ProjectConfig, WorkflowState } from "./types.js";

export interface ReconcilerOptions {
  store: Store;
  bus: EventBus;
  handlers: PhaseHandlers;
  workspace: Workspace;
  tickets: (projectId: string) => TicketStore;
  limits: Limits;
  backoff: BackoffPolicy;
  stallMs: number;
  host: string;
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
  skipped: { ticketId: string; reason: string }[];
}

const TICKET_STATUS: Partial<Record<Phase, TicketStatus>> = {
  spike: "in_progress",
  implement: "in_progress",
  checks: "in_progress",
  review: "review",
  qa: "qa",
};

export function stepKey(w: WorkflowState): string {
  return createHash("sha256")
    .update([w.projectId, w.ticketId, w.phase, w.attempt, w.loops].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

export class Reconciler {
  private readonly active = new Map<string, ActiveRun>();
  private readonly clock: () => Date;
  private readonly ids: () => string;

  constructor(private readonly o: ReconcilerOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.ids = o.ids ?? randomUUID;
  }

  /** Waits for every in-flight run; used by tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.active.size > 0)
      await Promise.allSettled([...this.active.values()].map((r) => r.promise));
  }

  stop(): void {
    for (const run of this.active.values()) run.controller.abort(new Error("reconciler stopped"));
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { dispatched: [], replayed: [], stalled: [], skipped: [] };
    await this.reapStalled(report);
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
      if (
        [...this.active.values()].some(
          (r) => r.projectId === w.projectId && r.ticketId === w.ticketId,
        )
      )
        continue;
      const reason = await this.blockedBy(project, w);
      if (reason) {
        report.skipped.push({ ticketId: w.ticketId, reason });
        continue;
      }
      const result = await this.dispatch(project, w);
      if (result === "dispatched") report.dispatched.push(w.ticketId);
      if (result === "replayed") report.replayed.push(w.ticketId);
    }
    return report;
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
    if (
      runs.filter((r) => r.host === project.host).length >=
      (limits.perHost[project.host] ?? limits.defaultPerHost)
    ) {
      return `host limit ${project.host}`;
    }
    if (project.dailyBudgetUsd !== undefined) {
      const spent = await this.o.store.getSpend(project.id, this.day());
      if (spent >= project.dailyBudgetUsd) return "daily budget reached";
    }
    return null;
  }

  private day(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  private async dispatch(
    project: ProjectConfig,
    w: WorkflowState,
  ): Promise<"dispatched" | "replayed" | "conflict"> {
    const key = stepKey(w);
    const done = await this.o.store.getStep(key);
    if (done?.completedAt && done.output) {
      // Idempotency: this exact step already finished (e.g. crash before the transition was saved).
      await this.transition(project, w, done.output as PhaseOutcome);
      return "replayed";
    }

    let state: WorkflowState;
    try {
      state = await this.o.store.saveWorkflow({ ...w, status: "running" });
    } catch (error) {
      if (error instanceof VersionConflictError) return "conflict";
      throw error;
    }

    const runId = this.ids();
    const model = this.modelFor(project, w.phase);
    const now = this.clock();
    await this.o.store.createRun({
      id: runId,
      projectId: project.id,
      ticketId: w.ticketId,
      phase: w.phase,
      attempt: w.attempt,
      stepKey: key,
      model,
      host: project.host,
      status: "running",
      startedAt: now,
      lastEventAt: now,
    });
    await this.o.store.startStep({
      key,
      runId,
      phase: w.phase,
      input: { ticketId: w.ticketId, attempt: w.attempt, loops: w.loops, model },
    });
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
    const promise = this.execute(project, state, runId, key, controller).finally(() =>
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

  private async execute(
    project: ProjectConfig,
    w: WorkflowState,
    runId: string,
    key: string,
    controller: AbortController,
  ): Promise<void> {
    let outcome: PhaseOutcome;
    try {
      const tickets = this.o.tickets(project.id);
      const ticket = await tickets.get(w.ticketId);
      if (!ticket) throw new Error(`ticket ${w.ticketId} not found`);
      const branch = `matrix/${w.ticketId}`;
      let workdir = w.workdir;
      if (!workdir) {
        const prepared = await this.o.workspace.prepare({
          projectId: project.id,
          ticketId: w.ticketId,
          repoPath: project.repoPath,
          branch,
          baseBranch: project.baseBranch,
        });
        workdir = prepared.workdir;
        w = await this.saveFresh(project.id, w.ticketId, (cur) => ({
          ...cur,
          workdir: prepared.workdir,
          workspaceRef: prepared.ref,
        }));
      }
      const status = TICKET_STATUS[w.phase];
      if (status)
        await tickets.update(w.ticketId, { status, phase: w.phase }).catch(() => undefined);
      const ctx: PhaseContext = {
        project,
        workflow: w,
        ticket,
        tickets,
        runId,
        workdir,
        branch,
        signal: controller.signal,
        emit: (message, kind = "log", data) => void this.record(runId, kind, message, data),
      };
      outcome = await this.o.handlers[w.phase](ctx);
      if (controller.signal.aborted) {
        outcome = {
          ok: false,
          summary: String(controller.signal.reason ?? "aborted"),
          receipts: outcome.receipts,
          runStatus: "timeout",
        };
      }
    } catch (error) {
      outcome = {
        ok: false,
        summary: (error as Error).message,
        receipts: [],
        runStatus: controller.signal.aborted ? "timeout" : "failed",
      };
    }
    await this.finish(project, runId, key, outcome);
    const current = await this.o.store.getWorkflow(project.id, w.ticketId);
    if (current && current.status === "running") await this.transition(project, current, outcome);
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
  ): Promise<void> {
    const status =
      outcome.runStatus && outcome.runStatus !== "ok"
        ? outcome.runStatus
        : outcome.ok
          ? "ok"
          : "failed";
    await this.o.store.updateRun(runId, {
      status,
      summary: outcome.summary,
      finishedAt: this.clock(),
      ...(outcome.runner ? { runner: outcome.runner } : {}),
      ...(outcome.model ? { model: outcome.model } : {}),
      ...(outcome.tokens
        ? { inputTokens: outcome.tokens.input, outputTokens: outcome.tokens.output }
        : {}),
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
    });
    await this.o.store.addReceipts(runId, outcome.receipts);
    // Crashed runs are not recorded as completed steps so they are retried, not replayed.
    if (!outcome.runStatus || outcome.runStatus === "ok") {
      await this.o.store.completeStep(key, {
        output: outcome,
        ok: outcome.ok,
        completedAt: this.clock(),
        ...(outcome.model ? { model: outcome.model } : {}),
        ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
      });
    }
    if (outcome.costUsd) await this.o.store.addSpend(project.id, this.day(), outcome.costUsd);
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
    const saved = await this.o.store.saveWorkflow(t.state);
    await this.applyEffects(project, saved, t);
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
        const approvalId = this.ids();
        await this.o.store.createApproval({
          id: approvalId,
          projectId: project.id,
          ticketId: saved.ticketId,
          phase: effect.phase,
          status: "pending",
          requestedAt: this.clock(),
        });
        this.o.bus.publish({
          type: "approval.requested",
          approvalId,
          projectId: project.id,
          ticketId: saved.ticketId,
          phase: effect.phase,
        });
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

  private async saveFresh(
    projectId: string,
    ticketId: string,
    update: (current: WorkflowState) => WorkflowState,
  ): Promise<WorkflowState> {
    for (let i = 0; i < 5; i++) {
      const current = await this.o.store.getWorkflow(projectId, ticketId);
      if (!current) throw new Error(`workflow ${projectId}/${ticketId} missing`);
      try {
        return await this.o.store.saveWorkflow(update(current));
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
      }
    }
    throw new VersionConflictError(projectId, ticketId);
  }

  private async reapStalled(report: TickReport): Promise<void> {
    const now = this.clock().getTime();
    const running = await this.o.store.listRuns({ status: ["running"] });
    for (const run of running) {
      const live = this.active.get(run.id);
      const stale = now - run.lastEventAt.getTime() > this.o.stallMs;
      if (live && !stale) continue;
      // Either no event for stallMs, or an orphan left by a crashed process.
      if (live) live.controller.abort(new Error(`stalled: no event for ${this.o.stallMs}ms`));
      await this.o.store.updateRun(run.id, {
        status: "stalled",
        finishedAt: this.clock(),
        summary: "stalled",
      });
      if (live) await live.promise.catch(() => undefined);
      const project = await this.o.store.getProject(run.projectId);
      const w = await this.o.store.getWorkflow(run.projectId, run.ticketId);
      if (project && w && w.status === "running" && w.phase === run.phase) {
        await this.transition(project, w, {
          ok: false,
          summary: "run stalled",
          receipts: [],
          runStatus: "timeout",
        });
      }
      report.stalled.push(run.ticketId);
    }
  }

  async decideApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    by: string,
    note?: string,
  ): Promise<WorkflowState> {
    const approval = await this.o.store.decideApproval(approvalId, decision, by, note);
    this.o.bus.publish({ type: "approval.decided", approvalId, status: decision });
    const project = await this.o.store.getProject(approval.projectId);
    if (!project) throw new Error(`project ${approval.projectId} not found`);
    const w = await this.o.store.getWorkflow(approval.projectId, approval.ticketId);
    if (!w || w.status !== "waiting_approval" || w.phase !== approval.phase) {
      throw new Error("workflow is no longer waiting for this approval");
    }
    if (decision === "approved") {
      const saved = await this.o.store.saveWorkflow(approve(w));
      this.o.bus.publish({ type: "workflow.changed", workflow: saved });
      return saved;
    }
    const t = reject(w, project, note ?? "rejected");
    const saved = await this.o.store.saveWorkflow(t.state);
    await this.applyEffects(project, saved, t);
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
