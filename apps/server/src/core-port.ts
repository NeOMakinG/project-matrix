import type { AutonomyMode, Phase, Receipt, RunEvent, RunStatus } from "@matrix/core";
import type { NewTicket, Ticket, TicketPatch, TicketQuery } from "@matrix/tickets";

export interface Project {
  id: string;
  name: string;
  description: string;
  workspace: "orca" | "native";
  autonomy: Record<Phase, AutonomyMode>;
  createdAt: string;
}

export type RunState = "queued" | "running" | "paused" | "awaiting_approval" | RunStatus;

/** Who performs an action. `kind` comes from the API key: humans vs automated agents. */
export interface Actor {
  keyId: string;
  kind: "human" | "agent";
}

export interface Run {
  id: string;
  projectId: string;
  ticketId: string;
  /** Key that started the run; it may never approve its own run. */
  startedBy: string;
  /** Commit currently under review. Approvals are bound to it; a new commit voids them. */
  headSha?: string;
  phase: Phase;
  state: RunState;
  runner: string;
  model: string;
  startedAt: string;
  updatedAt: string;
  costUsd: number;
  workspaceUrl?: string;
}

export type ApprovalDecision = "approve" | "request_changes";

export interface Approval {
  runId: string;
  decision: ApprovalDecision;
  commitSha: string;
  comment?: string;
  by: string;
  byKind: Actor["kind"];
  at: string;
}

export interface Adr {
  id: string;
  title: string;
  status: string;
  path: string;
  rules: string[];
}

export interface GraphNode {
  id: string;
  kind: "goal" | "persona" | "feature" | "decision" | "adr" | "ticket" | "module";
  label: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
}

export interface ProductGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface InitSession {
  id: string;
  projectId: string;
  answers: Record<string, unknown>;
  state: "in_progress" | "completed";
  createdAt: string;
}

export interface MonitorSignal {
  source: "sentry" | "posthog" | "github" | "otel";
  kind: string;
  projectId?: string;
  fingerprint?: string;
  title: string;
  payload: unknown;
  receivedAt: string;
}

export interface OrcaStatus {
  worktree: string;
  agent: string;
  status: string;
  runId?: string;
  message?: string;
  receivedAt: string;
}

export interface CorePort {
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(input: {
    name: string;
    description: string;
    workspace: Project["workspace"];
  }): Promise<Project>;
  setAutonomy(projectId: string, phase: Phase, mode: AutonomyMode): Promise<Project>;

  listTickets(projectId: string, query?: TicketQuery): Promise<Ticket[]>;
  createTicket(projectId: string, input: NewTicket): Promise<Ticket>;
  updateTicket(projectId: string, id: string, patch: TicketPatch): Promise<Ticket>;

  listRuns(projectId?: string): Promise<Run[]>;
  getRun(id: string): Promise<Run | null>;
  /** Must reject (not_found) when the ticket doesn't belong to the project. */
  startRun(
    input: { projectId: string; ticketId: string; phase: Phase },
    actor: Actor,
  ): Promise<Run>;
  pauseRun(id: string): Promise<Run>;
  cancelRun(id: string): Promise<Run>;
  listReceipts(runId: string): Promise<Receipt[]>;
  /**
   * Must enforce: the run is awaiting approval; `commitSha` equals the run's `headSha`; the actor is not
   * the key that started the run; when the project's merge autonomy is `human`, the actor is a human key.
   */
  approve(input: {
    runId: string;
    decision: ApprovalDecision;
    commitSha: string;
    actor: Actor;
    comment?: string;
  }): Promise<Approval>;
  /**
   * Must enforce: failed, cancelled and timed-out runs are never mergeable; an already merged run is a
   * conflict; every receipt must be present and passing (all modes); in `human` merge mode there must be
   * an `approve` by a human key bound to the current `headSha`.
   */
  merge(runId: string, actor: Actor): Promise<Run>;
  /**
   * Must enforce deploy autonomy: `human` requires a human actor; `gated` requires at least one merged
   * run and passing receipts on the latest merged run; `autonomous` allows agent deploys.
   */
  deploy(projectId: string, actor: Actor): Promise<{ id: string; state: string }>;
  subscribe(runId: string, listener: (event: RunEvent) => void): () => void;

  listAdrs(projectId: string): Promise<Adr[]>;
  getGraph(projectId: string): Promise<ProductGraph>;

  startInit(projectId: string): Promise<InitSession>;
  answerInit(sessionId: string, answers: Record<string, unknown>): Promise<InitSession>;
  getInit(sessionId: string): Promise<InitSession | null>;

  getSettings(): Promise<Record<string, unknown>>;
  updateSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>>;

  ingestSignal(signal: MonitorSignal): Promise<{ id: string }>;
  recordOrcaStatus(status: OrcaStatus): Promise<void>;
}

export class CoreError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid_state" | "forbidden",
    message: string,
  ) {
    super(message);
  }
}
