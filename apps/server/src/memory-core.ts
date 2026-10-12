import { randomUUID } from "node:crypto";
import { type AutonomyMode, PHASES, type Phase, type Receipt, type RunEvent } from "@matrix/core";
import type { NewTicket, Ticket, TicketPatch, TicketQuery } from "@matrix/tickets";
import {
  type Adr,
  type Approval,
  type ApprovalDecision,
  CoreError,
  type CorePort,
  type InitSession,
  type MonitorSignal,
  type OrcaStatus,
  type ProductGraph,
  type Project,
  type Run,
} from "./core-port.js";

const now = () => new Date().toISOString();

function defaultAutonomy(): Record<Phase, AutonomyMode> {
  const autonomy = {} as Record<Phase, AutonomyMode>;
  for (const phase of PHASES) autonomy[phase] = "human";
  return autonomy;
}

/** In-memory CorePort used by tests and until the orchestrator core lands. */
export class MemoryCore implements CorePort {
  readonly projects = new Map<string, Project>();
  readonly tickets = new Map<string, Ticket[]>();
  readonly runs = new Map<string, Run>();
  readonly receipts = new Map<string, Receipt[]>();
  readonly approvals: Approval[] = [];
  readonly signals: MonitorSignal[] = [];
  readonly orca: OrcaStatus[] = [];
  readonly inits = new Map<string, InitSession>();
  readonly adrs = new Map<string, Adr[]>();
  readonly graphs = new Map<string, ProductGraph>();
  private settings: Record<string, unknown> = {};
  private readonly listeners = new Map<string, Set<(event: RunEvent) => void>>();

  private project(id: string): Project {
    const project = this.projects.get(id);
    if (!project) throw new CoreError("not_found", `project ${id} not found`);
    return project;
  }

  private run(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new CoreError("not_found", `run ${id} not found`);
    return run;
  }

  emit(event: RunEvent): void {
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
  }

  private transition(id: string, state: Run["state"]): Run {
    const run = { ...this.run(id), state, updatedAt: now() };
    this.runs.set(id, run);
    this.emit({ runId: id, at: run.updatedAt, kind: "log", message: `state ${state}` });
    return run;
  }

  async listProjects() {
    return [...this.projects.values()];
  }

  async getProject(id: string) {
    return this.projects.get(id) ?? null;
  }

  async createProject(input: {
    name: string;
    description: string;
    workspace: Project["workspace"];
  }) {
    const project: Project = {
      id: randomUUID(),
      ...input,
      autonomy: defaultAutonomy(),
      createdAt: now(),
    };
    this.projects.set(project.id, project);
    this.tickets.set(project.id, []);
    return project;
  }

  async setAutonomy(projectId: string, phase: Phase, mode: AutonomyMode) {
    const project = this.project(projectId);
    const updated = { ...project, autonomy: { ...project.autonomy, [phase]: mode } };
    this.projects.set(projectId, updated);
    return updated;
  }

  async listTickets(projectId: string, query?: TicketQuery) {
    this.project(projectId);
    return (this.tickets.get(projectId) ?? []).filter(
      (t) =>
        (!query?.status || query.status.includes(t.status)) &&
        (!query?.labels || query.labels.every((l) => t.labels.includes(l))),
    );
  }

  async createTicket(projectId: string, input: NewTicket) {
    this.project(projectId);
    const list = this.tickets.get(projectId) ?? [];
    const ticket: Ticket = {
      id: `T-${list.length + 1}`,
      title: input.title,
      body: input.body,
      status: "open",
      labels: input.labels ?? [],
      deps: input.deps ?? [],
      createdAt: now(),
      updatedAt: now(),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.parent === undefined ? {} : { parent: input.parent }),
    };
    list.push(ticket);
    this.tickets.set(projectId, list);
    return ticket;
  }

  async updateTicket(projectId: string, id: string, patch: TicketPatch) {
    const list = this.tickets.get(projectId) ?? [];
    const index = list.findIndex((t) => t.id === id);
    const current = list[index];
    if (!current) throw new CoreError("not_found", `ticket ${id} not found`);
    const updated = { ...current, ...patch, updatedAt: now() } as Ticket;
    list[index] = updated;
    return updated;
  }

  async listRuns(projectId?: string) {
    return [...this.runs.values()].filter((r) => !projectId || r.projectId === projectId);
  }

  async getRun(id: string) {
    return this.runs.get(id) ?? null;
  }

  async startRun(input: { projectId: string; ticketId: string; phase: Phase }) {
    this.project(input.projectId);
    const run: Run = {
      id: randomUUID(),
      ...input,
      state: "queued",
      runner: "claude-code",
      model: "claude-fable-5-1",
      startedAt: now(),
      updatedAt: now(),
      costUsd: 0,
    };
    this.runs.set(run.id, run);
    this.receipts.set(run.id, []);
    return run;
  }

  async pauseRun(id: string) {
    const run = this.run(id);
    if (!["queued", "running"].includes(run.state)) {
      throw new CoreError("invalid_state", `cannot pause a ${run.state} run`);
    }
    return this.transition(id, "paused");
  }

  async cancelRun(id: string) {
    const run = this.run(id);
    if (["ok", "failed", "timeout", "cancelled"].includes(run.state)) {
      throw new CoreError("invalid_state", `run already ${run.state}`);
    }
    return this.transition(id, "cancelled");
  }

  async listReceipts(runId: string) {
    this.run(runId);
    return this.receipts.get(runId) ?? [];
  }

  async approve(runId: string, decision: ApprovalDecision, by: string, comment?: string) {
    const run = this.run(runId);
    if (run.state !== "awaiting_approval") {
      throw new CoreError("invalid_state", "run is not awaiting approval");
    }
    const approval: Approval = { runId, decision, by, at: now(), ...(comment ? { comment } : {}) };
    this.approvals.push(approval);
    this.transition(runId, decision === "approve" ? "running" : "queued");
    return approval;
  }

  async merge(runId: string, _by: string) {
    const run = this.run(runId);
    const project = this.project(run.projectId);
    const approved = this.approvals.some((a) => a.runId === runId && a.decision === "approve");
    if (project.autonomy.merge === "human" && !approved) {
      throw new CoreError("invalid_state", "merge requires a human approval for this project");
    }
    return this.transition(runId, "ok");
  }

  async deploy(projectId: string, _by: string) {
    this.project(projectId);
    return { id: randomUUID(), state: "queued" };
  }

  subscribe(runId: string, listener: (event: RunEvent) => void) {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => set.delete(listener);
  }

  async listAdrs(projectId: string) {
    this.project(projectId);
    return this.adrs.get(projectId) ?? [];
  }

  async getGraph(projectId: string) {
    this.project(projectId);
    return this.graphs.get(projectId) ?? { nodes: [], edges: [] };
  }

  async startInit(projectId: string) {
    this.project(projectId);
    const session: InitSession = {
      id: randomUUID(),
      projectId,
      answers: {},
      state: "in_progress",
      createdAt: now(),
    };
    this.inits.set(session.id, session);
    return session;
  }

  async answerInit(sessionId: string, answers: Record<string, unknown>) {
    const session = this.inits.get(sessionId);
    if (!session) throw new CoreError("not_found", `init session ${sessionId} not found`);
    const updated = { ...session, answers: { ...session.answers, ...answers } };
    this.inits.set(sessionId, updated);
    return updated;
  }

  async getInit(sessionId: string) {
    return this.inits.get(sessionId) ?? null;
  }

  async getSettings() {
    return this.settings;
  }

  async updateSettings(patch: Record<string, unknown>) {
    this.settings = { ...this.settings, ...patch };
    return this.settings;
  }

  async ingestSignal(signal: MonitorSignal) {
    this.signals.push(signal);
    return { id: randomUUID() };
  }

  async recordOrcaStatus(status: OrcaStatus) {
    this.orca.push(status);
  }
}
