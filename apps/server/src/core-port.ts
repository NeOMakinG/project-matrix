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

export interface Run {
  id: string;
  projectId: string;
  ticketId: string;
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
  comment?: string;
  by: string;
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
  startRun(input: { projectId: string; ticketId: string; phase: Phase }): Promise<Run>;
  pauseRun(id: string): Promise<Run>;
  cancelRun(id: string): Promise<Run>;
  listReceipts(runId: string): Promise<Receipt[]>;
  approve(
    runId: string,
    decision: ApprovalDecision,
    by: string,
    comment?: string,
  ): Promise<Approval>;
  merge(runId: string, by: string): Promise<Run>;
  deploy(projectId: string, by: string): Promise<{ id: string; state: string }>;
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
    readonly code: "not_found" | "conflict" | "invalid_state",
    message: string,
  ) {
    super(message);
  }
}
