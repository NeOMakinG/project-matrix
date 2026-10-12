import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type AutonomyMode,
  type EventBus,
  PHASES,
  type Phase,
  type Receipt,
  type Reconciler,
  type RunEvent,
  type Store,
} from "@matrix/core";
import type { NewTicket, Ticket, TicketPatch, TicketQuery, TicketStore } from "@matrix/tickets";
import {
  type Actor,
  type Approval,
  type ApprovalDecision,
  type ApprovalStatus,
  type CheckResult,
  CoreError,
  type CorePort,
  type Incident,
  type IncidentStatus,
  type InitSession,
  type ModelHealth,
  type MonitorSignal,
  type OrcaRuntime,
  type OrcaStatus,
  type ProductGraph,
  type Project,
  type Run,
  type Adr as ServerAdr,
} from "../core-port.js";
import { newProjectConfig, type StoredProject, toApproval, toProject, toRun } from "./mapping.js";
import { DEFAULT_TICKETS, type TicketSettings, ticketStoreFor } from "./tickets.js";

export interface KnowledgePort {
  adrs(repoPath: string): Promise<ServerAdr[]>;
  graph(repoPath: string): Promise<ProductGraph>;
  checks(repoPath: string): Promise<CheckResult>;
}

export interface MonitorPort {
  ingest(signal: MonitorSignal): Promise<{ id: string }>;
  incidents(query: { projectId?: string; status?: IncidentStatus }): Promise<Incident[]>;
}

export interface RealCoreOptions {
  store: Store;
  bus: EventBus;
  reconciler: Reconciler;
  projectsRoot: string;
  host: string;
  knowledge: KnowledgePort;
  monitor: MonitorPort;
  /** Overrides the ticket store per project (tests). */
  ticketsFor?: (project: StoredProject) => TicketStore;
}

/** Maps core's plain errors onto the server's error codes. */
function translate(error: unknown): never {
  if (error instanceof CoreError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) throw new CoreError("not_found", message);
  if (/cannot be decided|requires|human/i.test(message)) throw new CoreError("forbidden", message);
  throw new CoreError("invalid_state", message);
}

/**
 * CorePort over the real orchestrator: projects and workflows live in the core store (Postgres in
 * production), runs are dispatched by the reconciler, approvals are decided through it, and run
 * events come from its event bus.
 */
export class RealCore implements CorePort {
  private readonly ticketStores = new Map<string, TicketStore>();
  private readonly inits = new Map<string, InitSession>();
  private settings: Record<string, unknown> = {};
  private readonly orca: OrcaStatus[] = [];
  readonly modelHealth: ModelHealth[] = [];

  constructor(private readonly o: RealCoreOptions) {}

  async ticketStore(projectId: string): Promise<TicketStore> {
    const cached = this.ticketStores.get(projectId);
    if (cached) return cached;
    const project = await this.config(projectId);
    const store = this.o.ticketsFor
      ? this.o.ticketsFor(project)
      : ticketStoreFor(project.repoPath, project.matrix?.tickets ?? DEFAULT_TICKETS);
    this.ticketStores.set(projectId, store);
    return store;
  }

  private async config(projectId: string): Promise<StoredProject> {
    const project = (await this.o.store.getProject(projectId)) as StoredProject | null;
    if (!project) throw new CoreError("not_found", `project ${projectId} not found`);
    return project;
  }

  // ── projects ────────────────────────────────────────────────────────────────────────────────

  async listProjects(): Promise<Project[]> {
    return (await this.o.store.listProjects()).map((p) => toProject(p as StoredProject));
  }

  async getProject(id: string): Promise<Project | null> {
    const project = (await this.o.store.getProject(id)) as StoredProject | null;
    return project ? toProject(project) : null;
  }

  async createProject(input: {
    name: string;
    description: string;
    workspace: Project["workspace"];
    tickets?: TicketSettings;
  }): Promise<Project> {
    const id = randomUUID();
    const repoPath = join(this.o.projectsRoot, id);
    await mkdir(repoPath, { recursive: true });
    const config = newProjectConfig({
      id,
      name: input.name,
      repoPath,
      host: this.o.host,
      meta: {
        description: input.description,
        workspace: input.workspace,
        tickets: input.tickets ?? DEFAULT_TICKETS,
        createdAt: new Date().toISOString(),
      },
    });
    await this.o.store.upsertProject(config);
    return toProject(config);
  }

  async setAutonomy(projectId: string, phase: Phase, mode: AutonomyMode): Promise<Project> {
    await this.config(projectId);
    await this.o.reconciler.setAutonomy(projectId, phase, mode, "server");
    return toProject(await this.config(projectId));
  }

  // ── tickets ─────────────────────────────────────────────────────────────────────────────────

  private async index(projectId: string, ticket: Ticket): Promise<void> {
    await this.o.store.indexTicket(projectId, {
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      labels: ticket.labels,
      ...(ticket.priority === undefined ? {} : { priority: ticket.priority }),
      ...(ticket.url ? { url: ticket.url } : {}),
    });
  }

  async listTickets(projectId: string, query?: TicketQuery): Promise<Ticket[]> {
    return (await this.ticketStore(projectId)).list(query);
  }

  async createTicket(projectId: string, input: NewTicket): Promise<Ticket> {
    const ticket = await (await this.ticketStore(projectId)).create(input);
    await this.index(projectId, ticket);
    return ticket;
  }

  async updateTicket(projectId: string, id: string, patch: TicketPatch): Promise<Ticket> {
    const store = await this.ticketStore(projectId);
    if (!(await store.get(id))) throw new CoreError("not_found", `ticket ${id} not found`);
    const ticket = await store.update(id, patch);
    await this.index(projectId, ticket);
    return ticket;
  }

  // ── runs ────────────────────────────────────────────────────────────────────────────────────

  private async runView(record: Parameters<typeof toRun>[0]): Promise<Run> {
    const store = await this.ticketStore(record.projectId).catch(() => undefined);
    const ticket = await store?.get(record.ticketId).catch(() => null);
    const pending = await this.o.store.getPendingApproval(
      record.projectId,
      record.ticketId,
      record.phase,
    );
    return toRun(record, {
      ...(ticket ? { title: ticket.title } : {}),
      awaitingApproval: pending?.runId === record.id,
    });
  }

  async listRuns(projectId?: string): Promise<Run[]> {
    const records = await this.o.store.listRuns(projectId ? { projectId } : {});
    return Promise.all(records.map((r) => this.runView(r)));
  }

  async getRun(id: string): Promise<Run | null> {
    const record = await this.o.store.getRun(id);
    return record ? this.runView(record) : null;
  }

  /**
   * Work starts by marking the ticket ready; the reconciler creates the workflow and dispatches the
   * first phase on its next tick (run here immediately). Returns the dispatched run, or a queued
   * placeholder when limits or dependencies hold it back.
   */
  async startRun(
    input: { projectId: string; ticketId: string; phase: Phase },
    _actor: Actor,
  ): Promise<Run> {
    const store = await this.ticketStore(input.projectId);
    const ticket = await store.get(input.ticketId);
    if (!ticket)
      throw new CoreError("not_found", `ticket ${input.ticketId} not found in this project`);
    if (input.phase !== "spike") {
      throw new CoreError(
        "invalid_state",
        "workflows start at spike; later phases are driven by the reconciler",
      );
    }
    if (ticket.status !== "ready")
      await this.updateTicket(input.projectId, ticket.id, { status: "ready" });
    await this.o.reconciler.tick().catch(translate);
    const runs = await this.o.store.listRuns({
      projectId: input.projectId,
      ticketId: input.ticketId,
    });
    const latest = runs.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()).at(-1);
    if (latest) return this.runView(latest);
    const now = new Date().toISOString();
    return {
      id: `queued:${input.ticketId}`,
      projectId: input.projectId,
      ticketId: input.ticketId,
      ownerId: this.o.reconciler.ownerId,
      phase: "spike",
      state: "queued",
      runner: "pending",
      model: "pending",
      startedAt: now,
      updatedAt: now,
      costUsd: 0,
      title: ticket.title,
    };
  }

  async pauseRun(_id: string): Promise<Run> {
    throw new CoreError("invalid_state", "pausing a run isn't supported by the core yet");
  }

  async cancelRun(_id: string): Promise<Run> {
    throw new CoreError("invalid_state", "cancelling a run isn't supported by the core yet");
  }

  async listReceipts(runId: string): Promise<Receipt[]> {
    if (!(await this.o.store.getRun(runId)))
      throw new CoreError("not_found", `run ${runId} not found`);
    return this.o.store.listReceipts(runId);
  }

  // ── approvals, merge, deploy ────────────────────────────────────────────────────────────────

  async listApprovals(query: { projectId?: string; status?: ApprovalStatus }): Promise<Approval[]> {
    const workflows = await this.o.store.listWorkflows();
    const out: Approval[] = [];
    for (const w of workflows) {
      if (query.projectId && w.projectId !== query.projectId) continue;
      for (const phase of PHASES) {
        for (const record of await this.o.store.listApprovals(w.projectId, w.ticketId, phase)) {
          if (!query.status || record.status === query.status) out.push(toApproval(record));
        }
      }
    }
    return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  async getApproval(id: string): Promise<Approval | null> {
    const record = await this.o.store.getApproval(id);
    return record ? toApproval(record) : null;
  }

  /** The reconciler enforces requester/reconciler/owner, phase, human-only and head-SHA rules. */
  async decideApproval(
    id: string,
    decision: ApprovalDecision,
    by: Actor,
    note?: string,
  ): Promise<Approval> {
    if (!(await this.o.store.getApproval(id)))
      throw new CoreError("not_found", `approval ${id} not found`);
    await this.o.reconciler.decideApproval(id, decision, by, note).catch(translate);
    // An approval unblocks the workflow; let the reconciler continue right away.
    await this.o.reconciler.tick().catch(() => undefined);
    const record = await this.o.store.getApproval(id);
    if (!record) throw new CoreError("not_found", `approval ${id} not found`);
    return toApproval(record);
  }

  /**
   * Merging and deploying are phases the reconciler runs once their approval is granted (merge port
   * and deploy port of the runtime). These calls nudge the reconciler and report the run's state.
   */
  async merge(runId: string, _actor: Actor): Promise<Run> {
    const record = await this.o.store.getRun(runId);
    if (!record) throw new CoreError("not_found", `run ${runId} not found`);
    if (["failed", "cancelled", "timeout"].includes(record.status)) {
      throw new CoreError("invalid_state", `a ${record.status} run can never be merged`);
    }
    await this.o.reconciler.tick().catch(translate);
    const latest = (
      await this.o.store.listRuns({ projectId: record.projectId, ticketId: record.ticketId })
    )
      .filter((r) => r.phase === "merge")
      .at(-1);
    if (!latest)
      throw new CoreError("invalid_state", "no merge has run yet: approve the merge first");
    return this.runView(latest);
  }

  async deploy(projectId: string, _actor: Actor): Promise<{ id: string; state: string }> {
    await this.config(projectId);
    await this.o.reconciler.tick().catch(translate);
    const latest = (await this.o.store.listRuns({ projectId }))
      .filter((r) => r.phase === "deploy")
      .at(-1);
    if (!latest)
      throw new CoreError("invalid_state", "nothing deployed yet: approve a deploy first");
    return { id: latest.id, state: latest.status };
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    return this.o.bus.subscribe((event) => {
      if (event.type === "run.event" && event.event.runId === runId) listener(event.event);
      if (event.type === "run.finished" && event.runId === runId) {
        listener({ runId, at: new Date().toISOString(), kind: "done", message: event.summary });
      }
    });
  }

  // ── knowledge ──────────────────────────────────────────────────────────────────────────────

  async listAdrs(projectId: string): Promise<ServerAdr[]> {
    return this.o.knowledge.adrs((await this.config(projectId)).repoPath);
  }

  async getGraph(projectId: string): Promise<ProductGraph> {
    return this.o.knowledge.graph((await this.config(projectId)).repoPath);
  }

  async getChecks(projectId: string): Promise<CheckResult | null> {
    return this.o.knowledge.checks((await this.config(projectId)).repoPath);
  }

  // ── init interview sessions ──────────────────────────────────────────────────────────────────

  async startInit(projectId: string): Promise<InitSession> {
    await this.config(projectId);
    const session: InitSession = {
      id: randomUUID(),
      projectId,
      answers: {},
      state: "in_progress",
      createdAt: new Date().toISOString(),
    };
    this.inits.set(session.id, session);
    return session;
  }

  async answerInit(sessionId: string, answers: Record<string, unknown>): Promise<InitSession> {
    const session = this.inits.get(sessionId);
    if (!session) throw new CoreError("not_found", `init session ${sessionId} not found`);
    const updated = { ...session, answers: { ...session.answers, ...answers } };
    this.inits.set(sessionId, updated);
    return updated;
  }

  async getInit(sessionId: string): Promise<InitSession | null> {
    return this.inits.get(sessionId) ?? null;
  }

  // ── settings, monitor, Orca, gateway ─────────────────────────────────────────────────────────

  async getSettings(): Promise<Record<string, unknown>> {
    return this.settings;
  }

  async updateSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.settings = { ...this.settings, ...patch };
    return this.settings;
  }

  ingestSignal(signal: MonitorSignal): Promise<{ id: string }> {
    return this.o.monitor.ingest(signal);
  }

  listIncidents(query: { projectId?: string; status?: IncidentStatus }): Promise<Incident[]> {
    return this.o.monitor.incidents(query);
  }

  async getModelHealth(): Promise<ModelHealth[]> {
    return this.modelHealth;
  }

  async getOrcaRuntime(): Promise<OrcaRuntime> {
    const latest = new Map<string, OrcaStatus>();
    for (const status of this.orca) latest.set(status.worktree, status);
    const last = this.orca.at(-1);
    return {
      status: last ? "healthy" : "unknown",
      activeWorktrees: [...latest.values()].filter(
        (s) => !["done", "idle", "failed", "cancelled"].includes(s.status),
      ).length,
      ...(last ? { lastSeen: last.receivedAt } : {}),
    };
  }

  async recordOrcaStatus(status: OrcaStatus): Promise<void> {
    this.orca.push(status);
    if (this.orca.length > 5000) this.orca.shift();
  }
}

export const ALL_PHASES = PHASES;
export type { Actor, Approval, ApprovalDecision, ApprovalStatus, OrcaRuntime, RunEvent };
