import type {
  AutonomyMode,
  Actor as CoreActor,
  Phase,
  QuotaStatus,
  Receipt,
  RunEvent,
  RunStatus,
} from "@matrix/core";
import type { NewTicket, Ticket, TicketPatch, TicketQuery } from "@matrix/tickets";
import type { PrivateStateOwner } from "./state-owner.js";

/** One dependency install step of an existing repo: argv (no shell) run in `cwd` (repo-relative). */
export interface SetupStep {
  cwd?: string;
  run: string[];
}

export interface Project {
  id: string;
  name: string;
  description: string;
  workspace: "orca" | "native";
  autonomy: Record<Phase, AutonomyMode>;
  createdAt: string;
  /** Present for an existing repo registered on the host (draft PRs, human merge on GitHub). */
  repo?: {
    external: true;
    baseBranch: string;
    remote: string;
    github: string;
    editablePaths: string[];
    /** Dependency install steps before checks; absent = detected from lockfiles. */
    setup?: SetupStep[];
    setupScripts: boolean;
  };
  /** Effective model per model-driven phase. */
  models?: Partial<Record<ModelPhase, { runner: RunnerKind; model: string }>>;
  checks?: CheckSpec[];
  /** Effective wall-clock limit per run of each phase (ms). */
  timeouts?: Record<string, number>;
  idleTimeoutMs?: number;
  implementGuidance?: string;
}

export type ModelPhase = "spike" | "design" | "implement" | "review" | "qa";
export type RunnerKind = "claude-code" | "codex" | "opencode";
export interface CheckSpec {
  kind: "typecheck" | "lint" | "test" | "adr-check";
  cmd: string[];
}
export interface ModelPlanInput {
  spike?: { runner: RunnerKind; model: string };
  design?: { runner: RunnerKind; model: string };
  implement?: { runner: RunnerKind; model: string };
  review?: { runner: RunnerKind; model: string };
  qa?: { runner: RunnerKind; model: string };
  reviewerFallbacks?: { runner: RunnerKind; model: string }[];
}
export interface TicketsInput {
  kind: "beads" | "markdown" | "github" | "linear";
  repo?: string;
  linear?: {
    teamKey: string;
    projectLabel: string;
    readyState?: string;
    apiKeyEnv?: string;
    app?: { clientIdEnv: string; clientSecretEnv: string };
  };
}
export interface CreateProjectInput {
  name: string;
  description: string;
  workspace: Project["workspace"];
  tickets?: TicketsInput;
  /** Check commands run by the checks and QA phases (the init interview sets these later). */
  checks?: CheckSpec[];
  /** Register an existing host repo instead of creating an empty one (MATRIX_REPO_ROOTS). */
  repo?: {
    path: string;
    baseBranch: string;
    remote?: string;
    editablePaths?: string[];
    setup?: SetupStep[];
    setupScripts?: boolean;
  };
  models?: ModelPlanInput;
  timeouts?: PhaseTimeoutsInput;
  idleTimeoutMs?: number;
  implementGuidance?: string;
}
/** Per-phase run wall clock in ms (validated 5-120 min at the HTTP edge). */
export type PhaseTimeoutsInput = {
  [phase in "spike" | "design" | "implement" | "checks" | "review" | "qa"]?: number | undefined;
};
export interface UpdateProjectInput {
  /** Existing repos only: paths agents may change (dot paths always stay denied). */
  repo?: { editablePaths?: string[]; setup?: SetupStep[] | null; setupScripts?: boolean };
  tickets?: TicketsInput;
  checks?: CheckSpec[];
  models?: ModelPlanInput;
  /** Replaces the per-phase overrides; null clears them. */
  timeouts?: PhaseTimeoutsInput | null;
  /** null resets to the runner default. */
  idleTimeoutMs?: number | null;
  /** null removes it. */
  implementGuidance?: string | null;
}

export type RunState = "queued" | "running" | "paused" | "awaiting_approval" | RunStatus;

/**
 * Who performs an action: core's structured Actor `{ id, kind }` (core #12). `id` is the identity the
 * core records (`key:<keyId>` for API keys); `kind` comes from the authenticated key or session.
 * The server always builds it from the credential, never from request input.
 */
export type Actor = CoreActor;

export interface Run {
  id: string;
  projectId: string;
  ticketId: string;
  /** Ticket title, for display. */
  title?: string;
  /** Draft PR opened for the run's branch, once there is one. */
  prUrl?: string;
  /** Identity that started the run; it may never decide an approval on its own run. */
  ownerId: string;
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

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalDecision = "approved" | "rejected";

/** Mirrors core's ApprovalRecord: requested by the reconciler, decided by someone else. */
export interface Approval {
  id: string;
  projectId: string;
  ticketId: string;
  phase: Phase;
  /** The run whose result is being approved (QA run for merge, merge run for deploy). */
  runId: string;
  /** Commit that was reviewed and tested; merge refuses any other HEAD. */
  headSha: string;
  requestedBy: string;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** Whether the decider was a human or an agent key; merge and deploy check it against autonomy. */
  decidedByKind?: Actor["kind"];
  note?: string;
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
  data?: Record<string, unknown> | undefined;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
}

export interface ProductGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  context?: Record<string, unknown> | undefined;
  architecture?: { path: string; readOnly: true; graph: unknown } | undefined;
}

export interface InitSession {
  id: string;
  projectId: string;
  answers: Record<string, unknown>;
  state: "in_progress" | "completed";
  createdAt: string;
  /** Set once the interview was finalized (artifacts generated). */
  result?: InitFinalizeResult;
}

/** Outcome of turning interview answers into a project (config, ADRs, scaffold, backlog). */
export type InitFinalizeResult =
  | { status: "missing"; missing: string[] }
  | {
      status: "contradictions";
      contradictions: { id: string; message: string; questions: string[] }[];
    }
  | { status: "invalid"; issues: { path: string; message: string }[] }
  | {
      status: "ok";
      files: string[];
      tickets: string[];
      warnings: string[];
      commit?: string;
    };

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

export type ModelHealthStatus = "ok" | "cooldown" | "throttled" | "down";

/** Health of one model route behind the gateway (e.g. CLIProxyAPI), for the dashboard. */
export interface ModelHealth {
  model: string;
  provider: string;
  status: ModelHealthStatus;
  /** 0..1 share of the current quota window used, when the gateway reports it. */
  utilization?: number;
  resetsAt?: string;
  detail?: string;
}

export type IncidentStatus = "open" | "fixing" | "resolved";

/** Prod signals grouped by root cause (fingerprint). */
export interface Incident {
  id: string;
  projectId?: string;
  source: MonitorSignal["source"];
  fingerprint: string;
  title: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  status: IncidentStatus;
  /** 0..1 estimate that an agent can fix it, once triage has run. */
  fixability?: number;
  ticketId?: string;
}

export interface OrcaRuntime {
  status: "healthy" | "degraded" | "unknown";
  host?: string;
  version?: string;
  activeWorktrees: number;
  lastSeen?: string;
}

/** Latest `matrix check` result on a project's default branch. */
export interface CheckResult {
  ref: string;
  violations: {
    level: "error" | "warn";
    adr: string;
    location: string;
    message: string;
    note: string;
  }[];
}

export interface CorePort {
  readonly stateOwner?: PrivateStateOwner | undefined;
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  getProjectPolicy(id: string): Promise<{ project: Project; version: string } | null>;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProject(projectId: string, patch: UpdateProjectInput): Promise<Project>;
  setAutonomy(projectId: string, phase: Phase, mode: AutonomyMode, actor: Actor): Promise<Project>;
  /** Sets several phases in one write (all or nothing). */
  setAutonomyPolicy(
    projectId: string,
    policy: Partial<Record<Phase, AutonomyMode>>,
    actor: Actor,
    expected?: string,
  ): Promise<Project>;

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
  /** Human stop of the run's ticket: the run is cancelled and its workflow blocks (no budget used). */
  cancelRun(id: string): Promise<Run>;
  /** Human stop of a ticket's active workflow; `stopped` is false when nothing was active. */
  cancelTicket(projectId: string, ticketId: string): Promise<CancelResult>;
  /** Human stop of every active workflow of a project. */
  cancelProject(projectId: string): Promise<CancelResult[]>;
  listReceipts(runId: string): Promise<Receipt[]>;
  listApprovals(query: { projectId?: string; status?: ApprovalStatus }): Promise<Approval[]>;
  getApproval(id: string): Promise<Approval | null>;
  /**
   * Same rules as core's `decideApproval`: the identity that requested it, any `reconciler:*` identity
   * and the run's owner can't decide; the approval must be pending; approving requires the run to have
   * succeeded and HEAD to still be the approval's `headSha`. The decider's kind is recorded with the
   * decision (core receives `by.id`).
   */
  decideApproval(
    id: string,
    decision: ApprovalDecision,
    by: Actor,
    note?: string,
  ): Promise<Approval>;
  /**
   * Must enforce: failed, cancelled and timed-out runs are never mergeable; an already merged run is a
   * conflict; every receipt must be present and passing (all modes); in `human` merge mode there must be
   * an approved approval whose phase is `merge`, for this run, bound to its current `headSha`, and
   * decided by a human. Approvals of other phases (e.g. `review`) never count.
   */
  merge(runId: string, actor: Actor): Promise<Run>;
  /**
   * Must enforce deploy autonomy. All modes need a merged run. `human` requires an approved approval
   * whose phase is `deploy`, for the latest merged run and its `headSha`, decided by a human; `gated`
   * requires passing receipts on the latest merged run; `autonomous` allows agent deploys.
   */
  deploy(projectId: string, actor: Actor): Promise<{ id: string; state: string }>;
  subscribe(runId: string, listener: (event: RunEvent) => void): () => void;

  listAdrs(projectId: string): Promise<Adr[]>;
  getChecks(projectId: string): Promise<CheckResult | null>;
  /** Recent tracker write failures, newest first (absent: the core has no tracker sync). */
  getTrackerFailures?(
    projectId: string,
  ): Promise<{ ticketId?: string; operation: string; message: string; at: string }[]>;
  /** Subscription quota state per provider (absent: the core runs without the quota guard). */
  getQuota?(): Promise<QuotaStatus[]>;
  getGraph(projectId: string): Promise<ProductGraph>;

  startInit(projectId: string): Promise<InitSession>;
  answerInit(sessionId: string, answers: Record<string, unknown>): Promise<InitSession>;
  /** Replaces the whole answer set (used when an earlier answer is revised). */
  replaceInitAnswers(sessionId: string, answers: Record<string, unknown>): Promise<InitSession>;
  /**
   * Runs the init generator for the session's answers into the project repo and applies the chosen
   * process settings to the project. Idempotent: a finalized session returns its stored result.
   */
  finalizeInit(sessionId: string, options?: { acceptRecommended?: boolean }): Promise<InitSession>;
  getInit(sessionId: string): Promise<InitSession | null>;

  getSettings(): Promise<Record<string, unknown>>;
  updateSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>>;

  ingestSignal(signal: MonitorSignal): Promise<{ id: string }>;
  listIncidents(query: { projectId?: string; status?: IncidentStatus }): Promise<Incident[]>;
  getModelHealth(): Promise<ModelHealth[]>;
  getOrcaRuntime(): Promise<OrcaRuntime>;
  recordOrcaStatus(status: OrcaStatus): Promise<void>;
}

export class CoreError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "conflict"
      | "invalid_state"
      | "invalid_request"
      | "forbidden"
      | "tracker_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface CancelResult {
  projectId: string;
  ticketId: string;
  stopped: boolean;
  reason: string;
}
