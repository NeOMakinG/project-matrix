import type { AutonomyMode, Phase, Receipt, RunEvent, RunnerId } from "./ports.js";
import type { ProjectConfig, WorkflowState } from "./types.js";

export type RunRecordStatus = "running" | "ok" | "failed" | "timeout" | "cancelled" | "stalled";

export interface RunRecord {
  id: string;
  projectId: string;
  ticketId: string;
  phase: Phase;
  attempt: number;
  stepKey: string;
  runner?: RunnerId;
  model?: string;
  host: string;
  ownerId: string;
  status: RunRecordStatus;
  summary?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  startedAt: Date;
  lastEventAt: Date;
  heartbeatAt: Date;
  finishedAt?: Date;
}

export interface StepRecord {
  key: string;
  runId: string;
  phase: Phase;
  input: unknown;
  output?: unknown;
  ok?: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  completedAt?: Date;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRecord {
  id: string;
  projectId: string;
  ticketId: string;
  phase: Phase;
  /** The run whose result is being approved (QA run for merge, merge run for deploy). */
  runId: string;
  /** Commit that was reviewed and tested; merge refuses any other HEAD. */
  headSha: string;
  /** Identity that triggered the request (reconciler or agent key); may not decide it. */
  requestedBy: string;
  status: ApprovalStatus;
  requestedAt: Date;
  decidedAt?: Date;
  decidedBy?: string;
  note?: string;
}

export interface AutonomyChange {
  projectId: string;
  phase: Phase | "default";
  mode: AutonomyMode;
  actor: string;
  reason?: string;
  at: Date;
}

export interface Lesson {
  projectId: string;
  ticketId: string;
  source: string;
  lesson: string;
}

export class VersionConflictError extends Error {
  constructor(projectId: string, ticketId: string) {
    super(`workflow ${projectId}/${ticketId} was modified concurrently`);
  }
}

export interface Store {
  upsertProject(config: ProjectConfig): Promise<void>;
  getProject(id: string): Promise<ProjectConfig | null>;
  listProjects(): Promise<ProjectConfig[]>;

  indexTicket(
    projectId: string,
    ticket: {
      id: string;
      title: string;
      status: string;
      priority?: number;
      labels: string[];
      url?: string;
    },
  ): Promise<void>;

  getWorkflow(projectId: string, ticketId: string): Promise<WorkflowState | null>;
  createWorkflow(state: WorkflowState): Promise<boolean>;
  /** Optimistic update: fails with VersionConflictError if `state.version` is stale. Returns the stored state (version + 1). */
  saveWorkflow(state: WorkflowState): Promise<WorkflowState>;
  listWorkflows(filter?: { status?: WorkflowState["status"][] }): Promise<WorkflowState[]>;

  createRun(run: RunRecord): Promise<void>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(filter?: {
    status?: RunRecordStatus[];
    projectId?: string;
    ticketId?: string;
  }): Promise<RunRecord[]>;

  appendEvent(event: RunEvent): Promise<void>;
  listEvents(runId: string): Promise<RunEvent[]>;
  addReceipts(runId: string, receipts: Receipt[]): Promise<void>;
  listReceipts(runId: string): Promise<Receipt[]>;

  getStep(key: string): Promise<StepRecord | null>;
  startStep(step: StepRecord): Promise<void>;
  completeStep(key: string, patch: Partial<StepRecord>): Promise<void>;

  createApproval(approval: ApprovalRecord): Promise<void>;
  getApproval(id: string): Promise<ApprovalRecord | null>;
  listApprovals(projectId: string, ticketId: string, phase: Phase): Promise<ApprovalRecord[]>;
  getPendingApproval(
    projectId: string,
    ticketId: string,
    phase: Phase,
  ): Promise<ApprovalRecord | null>;
  decideApproval(
    id: string,
    status: Exclude<ApprovalStatus, "pending">,
    by: string,
    note?: string,
  ): Promise<ApprovalRecord>;

  setAutonomy(change: AutonomyChange): Promise<void>;
  autonomyHistory(projectId: string): Promise<AutonomyChange[]>;

  addSpend(projectId: string, day: string, usd: number): Promise<number>;
  getSpend(projectId: string, day: string): Promise<number>;

  addLesson(lesson: Lesson): Promise<void>;
  listLessons(projectId: string): Promise<Lesson[]>;
}

const key = (p: string, t: string) => `${p}\u0000${t}`;
const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  private projects = new Map<string, ProjectConfig>();
  private workflows = new Map<string, WorkflowState>();
  private runs = new Map<string, RunRecord>();
  private steps = new Map<string, StepRecord>();
  private events = new Map<string, RunEvent[]>();
  private receipts = new Map<string, Receipt[]>();
  private approvals = new Map<string, ApprovalRecord>();
  private history: AutonomyChange[] = [];
  private spend = new Map<string, number>();
  private lessons: Lesson[] = [];
  readonly tickets = new Map<string, unknown>();

  async upsertProject(config: ProjectConfig) {
    this.projects.set(config.id, clone(config));
  }
  async getProject(id: string) {
    const p = this.projects.get(id);
    return p ? clone(p) : null;
  }
  async listProjects() {
    return [...this.projects.values()].map(clone);
  }
  async indexTicket(projectId: string, ticket: { id: string }) {
    this.tickets.set(key(projectId, ticket.id), clone(ticket));
  }
  async getWorkflow(projectId: string, ticketId: string) {
    const w = this.workflows.get(key(projectId, ticketId));
    return w ? clone(w) : null;
  }
  async createWorkflow(state: WorkflowState) {
    const k = key(state.projectId, state.ticketId);
    if (this.workflows.has(k)) return false;
    this.workflows.set(k, clone({ ...state, version: 0 }));
    return true;
  }
  async saveWorkflow(state: WorkflowState) {
    const k = key(state.projectId, state.ticketId);
    const current = this.workflows.get(k);
    if (!current || current.version !== state.version) {
      throw new VersionConflictError(state.projectId, state.ticketId);
    }
    const next = clone({ ...state, version: state.version + 1 });
    this.workflows.set(k, next);
    return clone(next);
  }
  async listWorkflows(filter?: { status?: WorkflowState["status"][] }) {
    return [...this.workflows.values()]
      .filter((w) => !filter?.status || filter.status.includes(w.status))
      .map(clone);
  }
  async createRun(run: RunRecord) {
    this.runs.set(run.id, clone(run));
  }
  async updateRun(id: string, patch: Partial<RunRecord>) {
    const r = this.runs.get(id);
    if (r) this.runs.set(id, { ...r, ...clone(patch) });
  }
  async getRun(id: string) {
    const r = this.runs.get(id);
    return r ? clone(r) : null;
  }
  async listRuns(filter?: { status?: RunRecordStatus[]; projectId?: string; ticketId?: string }) {
    return [...this.runs.values()]
      .filter((r) => !filter?.status || filter.status.includes(r.status))
      .filter((r) => !filter?.projectId || r.projectId === filter.projectId)
      .filter((r) => !filter?.ticketId || r.ticketId === filter.ticketId)
      .map(clone);
  }
  async appendEvent(event: RunEvent) {
    const list = this.events.get(event.runId) ?? [];
    list.push(clone(event));
    this.events.set(event.runId, list);
  }
  async listEvents(runId: string) {
    return (this.events.get(runId) ?? []).map(clone);
  }
  async addReceipts(runId: string, receipts: Receipt[]) {
    this.receipts.set(runId, [...(this.receipts.get(runId) ?? []), ...clone(receipts)]);
  }
  async listReceipts(runId: string) {
    return (this.receipts.get(runId) ?? []).map(clone);
  }
  async getStep(k: string) {
    const s = this.steps.get(k);
    return s ? clone(s) : null;
  }
  async startStep(step: StepRecord) {
    if (!this.steps.has(step.key)) this.steps.set(step.key, clone(step));
  }
  async completeStep(k: string, patch: Partial<StepRecord>) {
    const s = this.steps.get(k);
    if (s) this.steps.set(k, { ...s, ...clone(patch) });
  }
  async createApproval(a: ApprovalRecord) {
    this.approvals.set(a.id, clone(a));
  }
  async getApproval(id: string) {
    const a = this.approvals.get(id);
    return a ? clone(a) : null;
  }
  async listApprovals(projectId: string, ticketId: string, phase: Phase) {
    return [...this.approvals.values()]
      .filter((x) => x.projectId === projectId && x.ticketId === ticketId && x.phase === phase)
      .sort((x, y) => x.requestedAt.getTime() - y.requestedAt.getTime())
      .map(clone);
  }
  async getPendingApproval(projectId: string, ticketId: string, phase: Phase) {
    const a = [...this.approvals.values()].find(
      (x) =>
        x.projectId === projectId &&
        x.ticketId === ticketId &&
        x.phase === phase &&
        x.status === "pending",
    );
    return a ? clone(a) : null;
  }
  async decideApproval(id: string, status: "approved" | "rejected", by: string, note?: string) {
    const a = this.approvals.get(id);
    if (!a) throw new Error(`approval ${id} not found`);
    if (a.status !== "pending") throw new Error(`approval ${id} already ${a.status}`);
    const next: ApprovalRecord = {
      ...a,
      status,
      decidedAt: new Date(),
      decidedBy: by,
      ...(note ? { note } : {}),
    };
    this.approvals.set(id, next);
    return clone(next);
  }
  async setAutonomy(change: AutonomyChange) {
    this.history.push(clone(change));
    const p = this.projects.get(change.projectId);
    if (!p) return;
    if (change.phase === "default") p.autonomy.default = change.mode;
    else p.autonomy[change.phase] = change.mode;
  }
  async autonomyHistory(projectId: string) {
    return this.history.filter((h) => h.projectId === projectId).map(clone);
  }
  async addSpend(projectId: string, day: string, usd: number) {
    const k = key(projectId, day);
    const total = (this.spend.get(k) ?? 0) + usd;
    this.spend.set(k, total);
    return total;
  }
  async getSpend(projectId: string, day: string) {
    return this.spend.get(key(projectId, day)) ?? 0;
  }
  async addLesson(lesson: Lesson) {
    this.lessons.push(clone(lesson));
  }
  async listLessons(projectId: string) {
    return this.lessons.filter((l) => l.projectId === projectId).map(clone);
  }
}
