import { createHash, randomUUID } from "node:crypto";
import {
  AutonomyConflictError,
  type AutonomyMode,
  assertActor,
  PHASES,
  type Phase,
  type Receipt,
  type RunEvent,
} from "@matrix/core";
import type { NewTicket, Ticket, TicketPatch, TicketQuery } from "@matrix/tickets";
import type { CancelResult } from "./core-port.js";
import {
  type Actor,
  type Adr,
  type Approval,
  type ApprovalDecision,
  type ApprovalStatus,
  type CheckResult,
  CoreError,
  type CorePort,
  type CreateProjectInput,
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
  type UpdateProjectInput,
} from "./core-port.js";
import { validQaSettings } from "./integration/mapping.js";

const now = () => new Date().toISOString();
const CANCEL_REASON = "stopped by human (cancelled via API)";

function defaultAutonomy(): Record<Phase, AutonomyMode> {
  const autonomy = {} as Record<Phase, AutonomyMode>;
  for (const phase of PHASES) autonomy[phase] = "human";
  return autonomy;
}

/** In-memory CorePort used by tests and until the orchestrator core lands. */
export class MemoryCore implements CorePort {
  private readonly policyRevisions = new Map<string, number>();
  readonly projects = new Map<string, Project>();
  readonly tickets = new Map<string, Ticket[]>();
  readonly runs = new Map<string, Run>();
  readonly receipts = new Map<string, Receipt[]>();
  readonly approvals: Approval[] = [];
  readonly merged = new Map<string, string>();
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

  async createProject(input: CreateProjectInput) {
    if (input.repo)
      throw new CoreError("invalid_request", "existing repos need the native or orca runtime");
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      workspace: input.workspace,
      autonomy: defaultAutonomy(),
      createdAt: now(),
    };
    this.projects.set(project.id, project);
    this.tickets.set(project.id, []);
    return project;
  }

  async updateProject(projectId: string, patch: UpdateProjectInput) {
    const project = this.project(projectId);
    const { reviewerFallbacks: _fallbacks, ...models } = patch.models ?? {};
    const updated: Project = {
      ...project,
      ...(patch.checks ? { checks: patch.checks.map((c) => ({ ...c, cmd: [...c.cmd] })) } : {}),
      ...(patch.models ? { models: { ...project.models, ...models } } : {}),
      ...(patch.timeouts
        ? {
            timeouts: Object.fromEntries(
              Object.entries(patch.timeouts).filter(
                (e): e is [string, number] => e[1] !== undefined,
              ),
            ),
          }
        : {}),
      ...(patch.resources
        ? {
            resources: Object.fromEntries(
              Object.entries(patch.resources).flatMap(([k, r]) =>
                r
                  ? [
                      [
                        k,
                        {
                          ...(r.cpus !== undefined ? { cpus: r.cpus } : {}),
                          ...(r.memoryGb !== undefined ? { memoryGb: r.memoryGb } : {}),
                        },
                      ],
                    ]
                  : [],
              ),
            ),
          }
        : {}),
      ...(patch.baselineWarmup !== undefined ? { baselineWarmup: patch.baselineWarmup } : {}),
      ...(typeof patch.idleTimeoutMs === "number" ? { idleTimeoutMs: patch.idleTimeoutMs } : {}),
      ...(patch.implementGuidance ? { implementGuidance: patch.implementGuidance } : {}),
      ...(patch.qa
        ? {
            qa: {
              ...validQaSettings(patch.qa),
              driver: patch.qa.driver ?? "none",
            },
          }
        : {}),
    };
    if (patch.qa === null) delete updated.qa;
    if (patch.timeouts === null) delete updated.timeouts;
    if (patch.resources === null) delete updated.resources;
    if (patch.idleTimeoutMs === null) delete updated.idleTimeoutMs;
    if (patch.implementGuidance === null) delete updated.implementGuidance;
    this.projects.set(projectId, updated);
    return updated;
  }

  async setAutonomy(projectId: string, phase: Phase, mode: AutonomyMode) {
    const project = this.project(projectId);
    const updated = { ...project, autonomy: { ...project.autonomy, [phase]: mode } };
    this.projects.set(projectId, updated);
    this.policyRevisions.set(projectId, (this.policyRevisions.get(projectId) ?? 0) + 1);
    return updated;
  }

  async setAutonomyPolicy(
    projectId: string,
    policy: Partial<Record<Phase, AutonomyMode>>,
    _actor: Actor,
    expected?: string,
  ) {
    const project = this.project(projectId);
    if (expected !== undefined && expected !== this.policyVersion(projectId))
      throw new AutonomyConflictError();
    const updated = { ...project, autonomy: { ...project.autonomy, ...policy } };
    this.projects.set(projectId, updated);
    this.policyRevisions.set(projectId, (this.policyRevisions.get(projectId) ?? 0) + 1);
    return updated;
  }

  private policyVersion(projectId: string): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.project(projectId).autonomy,
          this.policyRevisions.get(projectId) ?? 0,
        ]),
      )
      .digest("hex");
  }

  async getProjectPolicy(projectId: string) {
    const project = await this.getProject(projectId);
    return project ? { project, version: this.policyVersion(projectId) } : null;
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

  async startRun(input: { projectId: string; ticketId: string; phase: Phase }, actor: Actor) {
    this.project(input.projectId);
    const ticket = (this.tickets.get(input.projectId) ?? []).find((t) => t.id === input.ticketId);
    if (!ticket) {
      throw new CoreError("not_found", `ticket ${input.ticketId} not found in this project`);
    }
    const run: Run = {
      id: randomUUID(),
      ...input,
      ownerId: actor.id,
      title: ticket.title,
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

  /** Test/fake helper: a new commit replaces the head and voids earlier approvals. */
  setHead(runId: string, sha: string, state: Run["state"] = "awaiting_approval") {
    const run = { ...this.run(runId), headSha: sha, state, updatedAt: now() };
    this.runs.set(runId, run);
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

  async cancelTicket(projectId: string, ticketId: string): Promise<CancelResult> {
    this.project(projectId);
    const active = [...this.runs.values()].filter(
      (r) =>
        r.projectId === projectId &&
        r.ticketId === ticketId &&
        ["queued", "running", "paused"].includes(r.state),
    );
    for (const run of active) this.transition(run.id, "cancelled");
    return { projectId, ticketId, stopped: active.length > 0, reason: CANCEL_REASON };
  }

  async cancelProject(projectId: string): Promise<CancelResult[]> {
    const ids = new Set(
      [...this.runs.values()]
        .filter(
          (r) => r.projectId === projectId && ["queued", "running", "paused"].includes(r.state),
        )
        .map((r) => r.ticketId),
    );
    this.project(projectId);
    return Promise.all([...ids].map((ticketId) => this.cancelTicket(projectId, ticketId)));
  }

  async listReceipts(runId: string) {
    this.run(runId);
    return this.receipts.get(runId) ?? [];
  }

  /** Fake-only: the reconciler asks for a decision on a run that finished its phase. */
  requestApproval(
    runId: string,
    phase: Phase = "merge",
    requestedBy = "reconciler:memory",
  ): Approval {
    const run = this.run(runId);
    if (!run.headSha) throw new CoreError("invalid_state", "run has no head commit");
    const approval: Approval = {
      id: randomUUID(),
      projectId: run.projectId,
      ticketId: run.ticketId,
      phase,
      runId,
      headSha: run.headSha,
      requestedBy,
      status: "pending",
      requestedAt: now(),
    };
    this.approvals.push(approval);
    return approval;
  }

  async listApprovals(query: { projectId?: string; status?: ApprovalStatus }) {
    return this.approvals.filter(
      (a) =>
        (!query.projectId || a.projectId === query.projectId) &&
        (!query.status || a.status === query.status),
    );
  }

  async getApproval(id: string) {
    return this.approvals.find((a) => a.id === id) ?? null;
  }

  async decideApproval(id: string, decision: ApprovalDecision, actor: Actor, note?: string) {
    assertActor(actor);
    const by = actor.id;
    const index = this.approvals.findIndex((a) => a.id === id);
    const approval = this.approvals[index];
    if (!approval) throw new CoreError("not_found", `approval ${id} not found`);
    if (by === approval.requestedBy || by.startsWith("reconciler:")) {
      throw new CoreError(
        "forbidden",
        "an approval cannot be decided by the identity that requested it",
      );
    }
    const run = this.run(approval.runId);
    if (by === run.ownerId) {
      throw new CoreError("forbidden", "an approval cannot be decided by the run's initiator");
    }
    if (approval.status !== "pending")
      throw new CoreError("conflict", `approval already ${approval.status}`);
    if (decision === "approved") {
      if (run.state !== "awaiting_approval") {
        throw new CoreError("invalid_state", "the approved run did not succeed");
      }
      if (run.headSha !== approval.headSha) {
        throw new CoreError(
          "conflict",
          "HEAD moved since the approval was requested; request a new approval",
        );
      }
    }
    const decided: Approval = {
      ...approval,
      status: decision,
      decidedAt: now(),
      decidedBy: by,
      decidedByKind: actor.kind,
      ...(note ? { note } : {}),
    };
    this.approvals[index] = decided;
    if (decision === "rejected") this.transition(run.id, "queued");
    return decided;
  }

  async merge(runId: string, _actor: Actor) {
    const run = this.run(runId);
    const project = this.project(run.projectId);
    if (["failed", "cancelled", "timeout"].includes(run.state)) {
      throw new CoreError("invalid_state", `a ${run.state} run can never be merged`);
    }
    if (this.merged.has(runId)) throw new CoreError("conflict", "run already merged");
    if (run.state !== "awaiting_approval" || !run.headSha) {
      throw new CoreError("invalid_state", "run has not finished QA");
    }
    const receipts = this.receipts.get(runId) ?? [];
    if (receipts.length === 0 || receipts.some((r) => !r.ok)) {
      throw new CoreError("invalid_state", "all receipts must be present and passing before merge");
    }
    if (project.autonomy.merge === "human") {
      if (!this.hasHumanApproval("merge", runId, run.headSha)) {
        throw new CoreError(
          "invalid_state",
          "merge requires a human-approved merge approval of the current commit",
        );
      }
    }
    this.merged.set(runId, now());
    return this.transition(runId, "ok");
  }

  async deploy(projectId: string, actor: Actor) {
    const project = this.project(projectId);
    const mode = project.autonomy.deploy;
    const latest = [...this.merged.entries()]
      .map(([id, at]) => ({ run: this.runs.get(id), at }))
      .filter((m) => m.run?.projectId === projectId)
      .sort((a, b) => a.at.localeCompare(b.at))
      .at(-1)?.run;
    if (!latest) throw new CoreError("invalid_state", "nothing merged to deploy");
    if (mode === "human" && !this.hasHumanApproval("deploy", latest.id, latest.headSha)) {
      throw new CoreError(
        "forbidden",
        `deploy requires a human-approved deploy approval (requested by ${actor.id})`,
      );
    }
    if (mode === "gated") {
      const receipts = this.receipts.get(latest.id) ?? [];
      if (receipts.length === 0 || receipts.some((r) => !r.ok)) {
        throw new CoreError("invalid_state", "latest merged run has failing receipts");
      }
    }
    return { id: randomUUID(), state: "queued" };
  }

  private hasHumanApproval(phase: Phase, runId: string, headSha: string | undefined): boolean {
    return this.approvals.some(
      (a) =>
        a.phase === phase &&
        a.runId === runId &&
        a.status === "approved" &&
        a.decidedByKind === "human" &&
        headSha !== undefined &&
        a.headSha === headSha,
    );
  }

  subscribe(runId: string, listener: (event: RunEvent) => void) {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => set.delete(listener);
  }

  readonly checks = new Map<string, CheckResult>();

  async getChecks(projectId: string) {
    this.project(projectId);
    return this.checks.get(projectId) ?? null;
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

  async replaceInitAnswers(sessionId: string, answers: Record<string, unknown>) {
    const session = this.inits.get(sessionId);
    if (!session) throw new CoreError("not_found", `init session ${sessionId} not found`);
    if (session.state === "completed")
      throw new CoreError("conflict", "the interview is already finalized");
    const updated = { ...session, answers };
    this.inits.set(sessionId, updated);
    return updated;
  }

  async finalizeInit(
    _sessionId: string,
    _options?: { acceptRecommended?: boolean },
  ): Promise<InitSession> {
    throw new CoreError(
      "invalid_state",
      "finalizing an interview needs the real core (project repo)",
    );
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

  readonly modelHealth: ModelHealth[] = [];

  async listIncidents(query: { projectId?: string; status?: IncidentStatus }) {
    const groups = new Map<string, Incident>();
    for (const signal of this.signals) {
      const fingerprint = signal.fingerprint ?? `${signal.source}:${signal.title}`;
      const key = `${signal.projectId ?? "-"}|${fingerprint}`;
      const current = groups.get(key);
      if (current) {
        current.count += 1;
        current.lastSeen = signal.receivedAt;
        continue;
      }
      groups.set(key, {
        id: key,
        source: signal.source,
        fingerprint,
        title: signal.title,
        count: 1,
        firstSeen: signal.receivedAt,
        lastSeen: signal.receivedAt,
        status: "open",
        ...(signal.projectId ? { projectId: signal.projectId } : {}),
      });
    }
    return [...groups.values()].filter(
      (i) =>
        (!query.projectId || i.projectId === query.projectId) &&
        (!query.status || i.status === query.status),
    );
  }

  async getModelHealth() {
    return this.modelHealth;
  }

  async getOrcaRuntime(): Promise<OrcaRuntime> {
    const latest = new Map<string, OrcaStatus>();
    for (const status of this.orca) latest.set(status.worktree, status);
    const last = this.orca.at(-1);
    return {
      status: last ? "healthy" : "unknown",
      activeWorktrees: [...latest.values()].filter(
        (s) => s.status !== "done" && s.status !== "idle",
      ).length,
      ...(last ? { lastSeen: last.receivedAt } : {}),
    };
  }

  async recordOrcaStatus(status: OrcaStatus) {
    this.orca.push(status);
  }
}
