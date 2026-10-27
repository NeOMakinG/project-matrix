import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NEEDS_HUMAN_LABEL,
  type TicketComment,
  type TicketStatus,
  type TicketStore,
} from "@matrix/tickets";
import {
  AGENT_QA_DEVICE_PROVENANCE,
  type AgentQaOutcome,
  type AgentQaPort,
  type AgentQaVerdict,
  agentQaDeviceRecord,
  agentQaInputs,
  deviceOutcomeFromRecord,
  infraFailure,
  isPreExisting,
  latestAgentQaReport,
  NO_CRITERIA,
  PRE_EXISTING_PREFIX,
  preExistingIssue,
  QA_FAILED_LABEL,
  QA_PASSED_LABEL,
  QA_RERUN_LABEL,
  renderAgentQaReport,
  rerunCommentPending,
  sameIssueTitle,
  standingAgentQaVerdict,
} from "./agent-qa.js";
import type { EventBus } from "./bus.js";
import {
  canonicalFigmaFile,
  classifyDesignScope,
  DesignBindingChangedError,
  type DesignEvidence,
  type DesignScope,
  designComparisonSchema,
  designEvidence,
  figmaConfigurationHash,
  spikePlanSchema,
  type UiContextPort,
} from "./design.js";
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
import {
  acceptanceCriteria,
  handoffTester,
  type ManualQaData,
  manualQaData,
  manualQaReason,
  manualQaStillAllowed,
  requiredDeviceSurfaces,
} from "./manual-qa.js";
import { DEFAULT_RUN_IDLE_MS, phaseTimeoutMs, resolveModel, selectModel } from "./models.js";
import type { AutonomyMode, Phase, RunEvent, RunEventKind, RunnerId, Workspace } from "./ports.js";
import type {
  Authorization,
  GitPort,
  PhaseContext,
  PullRequestEvidence,
  PullRequestPort,
} from "./ports-internal.js";
import {
  type CodeCriterionResult,
  classifyCriteria,
  type PullRequestFacts,
  verifyCodeCriteria,
} from "./qa-criteria.js";
import { publicQaReceipt } from "./qa-evidence.js";
import {
  isGatewayUnavailable,
  isQuotaError,
  type ProviderCooldown,
  providerOf,
  QuotaCooldowns,
  type QuotaPolicy,
  quotaFor,
} from "./quota.js";
import {
  type Actor,
  type ApprovalRecord,
  type LabelRetry,
  type RunRecord,
  type Store,
  VersionConflictError,
} from "./store.js";
import { bestEffortComments } from "./tracker-writes.js";
import type {
  BackoffPolicy,
  Limits,
  PhaseOutcome,
  ProjectConfig,
  QaSurface,
  WorkflowState,
} from "./types.js";

export interface ReconcilerOptions {
  uiContext?: UiContextPort;
  store: Store;
  bus: EventBus;
  handlers: PhaseHandlers;
  workspace: Workspace;
  git: GitPort;
  tickets: (projectId: string) => TicketStore;
  projectDispatchAllowed?: (projectId: string) => boolean;
  withTicketSnapshotLock?: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>;
  limits: Limits;
  backoff: BackoffPolicy;
  host: string;
  /** Unique per process. Approvals requested by a reconciler can never be decided by it. */
  ownerId?: string;
  /** How long a workflow lease lasts without a heartbeat before another reconciler may take over. */
  leaseMs?: number;
  heartbeatMs?: number;
  scratchRoot?: string;
  /**
   * Subscription quota guard (per-provider concurrency, hourly runs, 5h runner minutes, cooldown
   * on rate-limit errors, per-ticket runner minutes). Absent: only the classic limits apply.
   */
  quota?: QuotaPolicy;
  /**
   * Model gateway preflight for model phases: a reason when the gateway cannot confirm the model
   * right now (unreachable, no recent model list). The ticket then stays queued, no attempt spent.
   */
  gatewayReady?: (model: string) => Promise<string | null>;
  /** How often a human may re-queue one blocked ticket per UTC day (state flapping guard). */
  maxRequeuesPerDay?: number;
  /**
   * Host-side draft pull requests: once review and QA passed, the validated head is pushed and a
   * draft PR opened right before the merge approval is requested (retried on later ticks).
   */
  pullRequests?: PullRequestPort;
  /** Agent QA lane for projects with `qa.driver: "agent"`: tests the published draft PR. */
  agentQa?: AgentQaPort;
  /**
   * Waits between agent QA attempts that failed on infrastructure (DNS, network, registry 5xx,
   * disk, device offline) before any verdict is given. Default 5 then 10 minutes (3 tries).
   */
  agentQaInfraRetryDelaysMs?: readonly number[];
  /** When a re-run of a settled PASS/FAIL keeps failing on infra, try again this much later. */
  agentQaInfraRecheckMs?: number;
  /** Test hook for those waits (default: a real timer). */
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
  ids?: () => string;
}

interface ActiveRun {
  runId: string;
  projectId: string;
  ticketId: string;
  phase: Phase;
  model: string;
  /** Subscription the run draws on; undefined for phases that call no model. */
  provider: string | undefined;
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
  design: "in_progress",
  implement: "in_progress",
  checks: "in_progress",
  review: "review",
  qa: "qa",
};

const IRREVERSIBLE = new Set<Phase>(["merge", "deploy"]);
/** Runs that build/run the app or deploy it: bounded per host on their own (`heavyPerHost`). */
export const HEAVY_PHASES: ReadonlySet<Phase> = new Set<Phase>(["qa", "deploy"]);
/** Minimum spacing between two auto-merge attempts of one head (CI still pending, GitHub lag). */
const AUTO_MERGE_RETRY_MS = 60_000;
const AFTER_REVIEW = new Set<Phase>(["qa", "merge", "deploy"]);
/** Phases that validate or act on the code: they run only on a clean tree and record its commit. */
const CLEAN_TREE = new Set<Phase>(["design", "checks", "review", "qa", "merge", "deploy"]);
const VALIDATING = new Set<Phase>(["design", "checks", "review", "qa"]);

const HOUR_MS = 60 * 60_000;
/** Phases that call a model, i.e. draw on a subscription; the others never touch quota. */
const MODEL_PHASES = new Set<Phase>(["spike", "design", "implement", "review", "qa"]);
/** Consecutive quota deferrals one workflow may take before failures count as attempts again. */
const MAX_QUOTA_DEFERRALS = 5;
const FIVE_HOURS_MS = 5 * HOUR_MS;

interface ProviderUsage {
  runsLastHour: Map<string, number>;
  minutes5h: Map<string, number>;
}

export interface QuotaStatus {
  provider: string;
  limits: { maxConcurrent: number; maxRunsPerHour: number; maxRunnerMinutesPer5h: number };
  active: number;
  runsLastHour: number;
  runnerMinutes5h: number;
  cooldown?: { until: string; failures: number; reason: string; at: string };
}

const publicCooldown = (c: ProviderCooldown) => ({
  until: c.until.toISOString(),
  failures: c.failures,
  reason: c.reason,
  at: c.at.toISOString(),
});

const hash = (...parts: (string | number)[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);

/**
 * Last error of a run stopped by its phase wall clock. "Still active" (a tool call within the idle
 * window) means the budget was too small or the agent spent it on slow commands, not that it hung.
 */
export function runTimeoutSummary(
  timeoutMs: number,
  idleTimeoutMs: number | undefined,
  lastTool: { at: Date; message: string } | undefined,
  now: Date,
): string {
  const minutes = Math.round(timeoutMs / 6_000) / 10;
  const head = `run timeout after ${minutes} min`;
  if (!lastTool) return `${head} (no tool activity)`;
  const sinceMs = Math.max(0, now.getTime() - lastTool.at.getTime());
  const windowMs = idleTimeoutMs && idleTimeoutMs > 0 ? idleTimeoutMs : DEFAULT_RUN_IDLE_MS;
  const tool = lastTool.message.replace(/\s+/g, " ").trim().slice(0, 200);
  if (sinceMs <= windowMs) return `${head} while still active (last tool: ${tool})`;
  return `${head} (no tool activity for ${Math.round(sinceMs / 60_000)} min; last tool: ${tool})`;
}

export function stepKey(w: WorkflowState): string {
  // Generation 0 keeps the historical key so in-flight workflows replay as before.
  return w.generation
    ? hash(w.projectId, w.ticketId, w.phase, w.attempt, w.loops, `g${w.generation}`)
    : hash(w.projectId, w.ticketId, w.phase, w.attempt, w.loops);
}

/** Merge and deploy keys ignore the attempt so a retried irreversible action dedupes downstream. */
export function actionKey(w: WorkflowState, headSha: string): string {
  return hash(w.projectId, w.ticketId, w.phase, w.loops, headSha);
}

/**
 * Validates an actor at runtime. Identities are never inferred from strings: the server builds the
 * actor from the authenticated session or API key, including whether it is a human or an agent.
 */
export function assertActor(actor: unknown): asserts actor is Actor {
  const a = actor as Partial<Actor> | null;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof a.id !== "string" ||
    a.id.length === 0 ||
    (a.kind !== "human" && a.kind !== "agent")
  ) {
    throw new TypeError(
      "decideApproval requires a structured Actor { id, kind: 'human' | 'agent' }",
    );
  }
}

/** An approval only counts if a human decided it and that human isn't the requester or the run owner. */
function validApprover(a: ApprovalRecord, runOwner: string | undefined): boolean {
  if (a.decidedByKind !== "human" || !a.decidedBy) return false;
  if (a.decidedBy === a.requestedBy || a.decidedBy.startsWith("reconciler:")) return false;
  return a.decidedBy !== runOwner;
}

/** Prefix of the last error of a workflow a human stopped; a later restart costs no budget. */
export const HUMAN_STOP = "stopped by human";

/** Abort reason of a run a human stopped (vs. timeouts, lease loss, shutdown). */
export class HumanStopError extends Error {}
/** Abort reason when this reconciler shuts down (deploy/restart): the run is re-queued, never counted. */
export class ShutdownError extends Error {}
export const INTERRUPTED_SUMMARY =
  "interrupted by reconciler shutdown; re-queued (not counted as an attempt)";

const ACTIVE_STATUSES = ["pending", "running", "waiting_approval"] as const;

export class Reconciler {
  /** Heads whose draft PR is published (skips repeat work on later ticks). */
  private readonly published = new Set<string>();
  /** PR url per published `${project}\0${ticket}\0${head}` key (agent QA needs it). */
  private readonly publishedUrls = new Map<string, string>();
  /** In-flight agent QA jobs by the same key. */
  private readonly agentQaJobs = new Map<string, Promise<void>>();
  /** Last agent QA verdict per key (PASS/FAIL are final for a head; BLOCKED waits for a human). */
  private readonly agentQaVerdicts = new Map<string, AgentQaVerdict>();
  /** Finished reports whose comment could not be posted yet: retried, never re-run. */
  private readonly agentQaUnposted = new Map<string, { body: string; verdict: AgentQaVerdict }>();
  /** BLOCKED keys whose needs-human label was seen on the ticket (removal then means retry). */
  private readonly agentQaBlockedSeen = new Set<string>();
  /** QA keys whose re-run failed on infra while a PASS/FAIL stood: when to try again, how often. */
  private readonly agentQaInfraRetry = new Map<string, { at: number; count: number }>();
  /** Last rerun-trigger check (label, PR description, criteria) per QA key: at most every 2 min. */
  private readonly agentQaTriggerAt = new Map<string, number>();
  /**
   * Agent QA label writes that failed, by `${project}\0${ticket}`: retried every tick whatever the
   * workflow's phase (a FAIL already looped back), so a stale `qa:passed` never outlives a FAIL.
   */
  private readonly agentQaLabelsPending = new Map<string, AgentQaLabelFix>();
  /** The newest label fix per ticket (older ones in flight never re-queue over it). */
  private readonly agentQaLabelsLatest = new Map<string, AgentQaLabelFix>();
  /** Label writes queued by an earlier process were reloaded from the store. */
  private agentQaLabelsResumed = false;
  /**
   * Backoff of a failing label write, by the same key: when the next retry may run, and when a
   * permanent (permission) failure was last logged, so a label nobody may create never storms.
   */
  private readonly agentQaLabelsBackoff = new Map<string, { nextAt: number; loggedAt?: number }>();
  /** Tail of each ticket's label-retry store writes (keeps them in issue order). */
  private readonly labelRetryOps = new Map<string, Promise<void>>();
  readonly ownerId: string;
  private readonly active = new Map<string, ActiveRun>();
  private readonly clock: () => Date;
  private readonly ids: () => string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly scratchRoot: string;
  private readonly cooldowns: QuotaCooldowns | undefined;
  /** Consecutive quota deferrals per workflow; past the cap a failure counts as an attempt. */
  private readonly quotaDeferrals = new Map<string, number>();
  private usage: Promise<ProviderUsage> | undefined;
  /** Set by stop(): a shutting-down reconciler never dispatches again (re-queued runs wait). */
  private stopping = false;

  constructor(private readonly o: ReconcilerOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.ids = o.ids ?? randomUUID;
    this.ownerId = o.ownerId ?? `reconciler:${randomUUID().slice(0, 8)}`;
    if (!this.ownerId.startsWith("reconciler:"))
      throw new Error('ownerId must start with "reconciler:"');
    this.leaseMs = o.leaseMs ?? 60_000;
    this.heartbeatMs = o.heartbeatMs ?? Math.max(1_000, Math.floor(this.leaseMs / 3));
    this.scratchRoot = o.scratchRoot ?? join(tmpdir(), "matrix-scratch");
    this.cooldowns = o.quota ? new QuotaCooldowns(o.quota) : undefined;
  }

  /** Waits for every in-flight run; used by tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((r) => r.promise));
    }
  }

  /** Waits for in-flight agent QA jobs (tests and graceful shutdown). */
  async agentQaIdle(): Promise<void> {
    while (this.agentQaJobs.size > 0) await Promise.allSettled([...this.agentQaJobs.values()]);
  }

  stop(): void {
    this.stopping = true;
    for (const run of this.active.values())
      run.controller.abort(new ShutdownError("reconciler stopped"));
  }

  private get maxRequeues(): number {
    return this.o.maxRequeuesPerDay ?? 3;
  }

  async tick(): Promise<TickReport> {
    this.usage = undefined;
    const report: TickReport = {
      dispatched: [],
      replayed: [],
      stalled: [],
      awaitingApproval: [],
      skipped: [],
    };
    await this.reapExpired(report);
    const projects = await this.o.store.listProjects();
    for (const project of projects) {
      if (this.o.projectDispatchAllowed?.(project.id) !== false) await this.syncReady(project);
      await this.honorStopRequests(project);
    }

    const now = this.clock();
    const byId = new Map(projects.map((project) => [project.id, project]));
    const pending = (await this.o.store.listWorkflows({ status: ["pending", "waiting_approval"] }))
      .filter((workflow) => {
        if (workflow.status === "pending") return true;
        const project = byId.get(workflow.projectId);
        return (
          workflow.phase === "design" &&
          project &&
          !requiresApproval(autonomyFor(project, "design"), "design")
        );
      })
      .filter((w) => !w.nextAttemptAt || w.nextAttemptAt <= now)
      .sort((a, b) => a.priority - b.priority);

    for (const w of pending) {
      const project = byId.get(w.projectId);
      if (!project) continue;
      if (this.o.projectDispatchAllowed?.(project.id) === false) {
        report.skipped.push({ ticketId: w.ticketId, reason: "project finalize incomplete" });
        continue;
      }
      if (this.isActive(w)) continue;
      const cap = await this.ticketCapReason(project, w);
      if (cap) {
        await this.blockForHuman(project, w, cap);
        report.skipped.push({ ticketId: w.ticketId, reason: cap });
        continue;
      }
      const reason = await this.blockedBy(project, w);
      if (reason) {
        report.skipped.push({ ticketId: w.ticketId, reason });
        continue;
      }
      if (this.o.projectDispatchAllowed?.(project.id) === false) continue;
      if (this.stopping) break;
      const result = await this.dispatch(project, w);
      this.usage = undefined;
      if (result === "dispatched") report.dispatched.push(w.ticketId);
      else if (result === "replayed") report.replayed.push(w.ticketId);
      else if (result === "approval") report.awaitingApproval.push(w.ticketId);
    }
    await this.resumeAgentQaLabels();
    for (const fix of [...this.agentQaLabelsPending.values()]) {
      const project = byId.get(fix.projectId);
      const backoff = this.agentQaLabelsBackoff.get(`${fix.projectId}\u0000${fix.ticketId}`);
      if (backoff && this.clock().getTime() < backoff.nextAt) continue;
      if (project) await this.writeAgentQaLabels(project, fix);
    }
    for (const w of await this.o.store.listWorkflows({ status: ["waiting_approval"] })) {
      const project = byId.get(w.projectId);
      if (!project || w.phase !== "merge" || this.isActive(w)) continue;
      if (await this.adoptExternalHead(project, w)) continue;
      if (this.o.pullRequests) await this.publishPullRequest(project, w);
      await this.observeHandoff(project, w);
      await this.maybeRunAgentQa(project, w);
      await this.maybeAutoMerge(project, w);
    }
    return report;
  }

  /**
   * Pushes the validated head and opens (or reuses) the draft PR. Failures never fail the
   * workflow: they surface as tracker failures and the next tick retries (the port dedupes).
   */
  private async publishPullRequest(project: ProjectConfig, w: WorkflowState): Promise<void> {
    const port = this.o.pullRequests;
    if (!port || !w.workdir || port.handles?.(project) === false) return;
    try {
      const headSha = await this.o.git.headSha(w.workdir);
      const key = `${project.id}\u0000${w.ticketId}\u0000${headSha}`;
      if (this.published.has(key)) return;
      this.publishedUrls.delete(key);
      // Only the exact commit QA validated, with every earlier gate still holding, is published.
      const qa = await this.candidateRun(w, "merge");
      if (!qa?.headSha || qa.headSha !== headSha)
        throw new Error("worktree head differs from the QA-validated head; not publishing");
      const problems = await this.gateProblems(project, w, "merge");
      if (problems) throw new Error(`gates no longer hold: ${problems}`);
      const ticket = await this.o.tickets(project.id).get(w.ticketId);
      if (!ticket) throw new Error(`ticket ${w.ticketId} not found`);
      const manual = await this.latestManualQa(w);
      const published = await port.publish({
        project,
        workflow: w,
        ticket,
        headSha,
        evidence: await this.pullRequestEvidence(w),
        ...(manual ? { manualQa: { surfaces: manual.surfaces, criteria: manual.criteria } } : {}),
      });
      if (published) {
        if (this.published.size > 5_000) {
          this.published.clear();
          this.publishedUrls.clear();
        }
        this.published.add(key);
        this.publishedUrls.set(key, published.url);
      }
      if (published)
        this.o.bus.publish({
          type: "pull_request.opened",
          projectId: project.id,
          ticketId: w.ticketId,
          url: published.url,
          branch: published.branch,
          ...(manual ? { manualQa: manualQaReason(manual.surfaces, manual.tester) } : {}),
        });
      if (
        published &&
        manual &&
        manual.tester !== "agent" &&
        !(await this.announced(project, w.ticketId, published.url))
      )
        await this.announceManualQa(project, w, manual, published.url);
    } catch (error) {
      this.trackerFailed(project.id, w.ticketId, "pull-request", error);
    }
  }

  private async pullRequestEvidence(w: WorkflowState): Promise<PullRequestEvidence[]> {
    const runs = await this.o.store.listRuns({ projectId: w.projectId, ticketId: w.ticketId });
    const out: PullRequestEvidence[] = [];
    for (const phase of ["checks", "review", "qa"] as const) {
      const run = runs
        .filter((r) => r.phase === phase && r.status === "ok")
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
        .at(-1);
      if (!run) continue;
      const urls = (await this.o.store.listReceipts(run.id))
        .map((receipt) => receipt.url)
        .filter((url): url is string => typeof url === "string" && url.startsWith("https://"));
      out.push({ phase, summary: run.summary ?? "", urls: [...new Set(urls)].slice(0, 10) });
    }
    return out;
  }

  /** `handoffKey` of handoffs whose ticket was seen outside Ready (in memory: fails safe). */
  private readonly handoffLeftReady = new Set<string>();

  private handoffKey(w: WorkflowState, qaRunId: string): string {
    return `${w.projectId}\u0000${w.ticketId}\u0000${qaRunId}`;
  }

  /** Remembers that a handoff's ticket left Ready, so a later Ready means a human moved it back. */
  private async observeHandoff(project: ProjectConfig, w: WorkflowState): Promise<void> {
    const run = await this.latestRun(w, "qa");
    if (!run || this.handoffLeftReady.has(this.handoffKey(w, run.id))) return;
    if (!(await this.latestManualQa(w))) return;
    try {
      const ticket = await this.o.tickets(project.id).get(w.ticketId);
      if (ticket && ticket.status !== "ready") {
        if (this.handoffLeftReady.size > 5_000) this.handoffLeftReady.clear();
        this.handoffLeftReady.add(this.handoffKey(w, run.id));
      }
    } catch (error) {
      this.trackerFailed(project.id, w.ticketId, "get", error);
    }
  }

  /**
   * A ticket waiting on a manual QA handoff that a human moved back to Ready is QA feedback: the
   * merge approval is withdrawn and the workflow loops back to implement (the human's ticket
   * comments reach the implementer). Only for manual handoffs; true when it looped.
   */
  private async manualQaFeedback(project: ProjectConfig, ticketId: string): Promise<boolean> {
    const w = await this.o.store.getWorkflow(project.id, ticketId);
    if (!w || w.status !== "waiting_approval" || w.phase !== "merge" || this.isActive(w))
      return false;
    if (!(await this.latestManualQa(w))) return false;
    // Still in Ready since the handoff (e.g. the column move failed): not a human's feedback.
    const qaRun = await this.latestRun(w, "qa");
    if (!qaRun || !this.handoffLeftReady.delete(this.handoffKey(w, qaRun.id))) return false;
    const saved = await this.loopBackFromQa(
      project,
      w,
      "manual QA feedback: a human moved the ticket back to Ready; address their ticket comments",
      "manual QA feedback",
    );
    // Loop limit reached (or lost a race): the block effect already labelled and explained it.
    if (!saved || saved.status === "blocked") return true;
    const tickets = this.o.tickets(project.id);
    if (tickets.removeLabel)
      await this.trackerWrite(project.id, ticketId, "removeLabel", async () =>
        tickets.removeLabel?.(ticketId, NEEDS_HUMAN_LABEL),
      );
    await this.trackerWrite(project.id, ticketId, "comment", () =>
      tickets.comment(
        ticketId,
        "Matrix took the move back to Ready as manual QA feedback: the merge approval is withdrawn and the next run addresses your comments (review loop).",
      ),
    );
    return true;
  }

  /**
   * QA said the change is not good: withdraws the pending merge approval and loops back to
   * implement (a review loop, counted against maxLoops). Undefined when another writer won.
   */
  private async loopBackFromQa(
    project: ProjectConfig,
    w: WorkflowState,
    reason: string,
    approvalNote: string,
  ): Promise<WorkflowState | undefined> {
    const fresh = (await this.o.store.getProject(project.id)) ?? project;
    const t = reject(w, fresh, reason);
    let saved: WorkflowState;
    try {
      saved = await this.o.store.saveWorkflow(t.state);
    } catch (error) {
      if (error instanceof VersionConflictError) return undefined;
      throw error;
    }
    for (const a of await this.o.store.listApprovals(w.projectId, w.ticketId, "merge"))
      if (a.status === "pending")
        await this.o.store
          .decideApproval(a.id, "rejected", { id: this.ownerId, kind: "agent" }, approvalNote)
          .catch(() => undefined);
    await this.applyEffects(fresh, saved, { ...t, state: saved });
    return saved;
  }

  /**
   * Starts the agent QA lane on a published draft PR (projects with `qa.driver: "agent"`), once
   * per head. The job runs in the background; its verdict drives the ticket (see agent-qa.ts).
   */
  private async maybeRunAgentQa(project: ProjectConfig, w: WorkflowState): Promise<void> {
    if (!w.workdir) return;
    const manual = await this.latestManualQa(w);
    if (!manual) return;
    // A human handoff from before the project switched to the agent driver: the lane may take it,
    // but only once a human removed needs-human (the handoff's "a human tests this" stays the
    // default until someone hands it over).
    const handedOver = manual.tester !== "agent";
    if (handedOver && (handoffTester(project) !== "agent" || !this.o.agentQa?.handles(project)))
      return;
    let headSha: string;
    try {
      headSha = await this.o.git.headSha(w.workdir);
    } catch {
      return;
    }
    const qaRun = await this.latestRun(w, "qa");
    if (!qaRun) return;
    const url = this.publishedUrls.get(`${project.id}\u0000${w.ticketId}\u0000${headSha}`);
    const key = `${project.id}\u0000${w.ticketId}\u0000${headSha}\u0000${qaRun.id}`;
    if (!url || this.agentQaJobs.has(key)) return;
    const tickets = this.o.tickets(project.id);
    let comments: TicketComment[] = [];
    try {
      comments = (await tickets.listComments?.(w.ticketId)) ?? [];
    } catch (error) {
      this.trackerFailed(project.id, w.ticketId, "list-comments", error);
      return;
    }
    const unposted = this.agentQaUnposted.get(key);
    if (unposted) {
      await this.postAgentQaReport(project, w, key, url, unposted);
      return;
    }
    const applied = this.agentQaVerdicts.get(key);
    const latest = latestAgentQaReport(comments, headSha, qaRun.id);
    // An infra BLOCKED (e.g. posted before this guard existed) never replaces the PASS/FAIL posted
    // before it for the same inputs: that verdict and its labels stand again.
    const standing = applied ? undefined : standingAgentQaVerdict(comments, headSha, qaRun.id);
    if (standing) {
      console.error(
        `[agent-qa] ${w.ticketId} ${headSha.slice(0, 12)}: newest report is an infra BLOCKED (${standing.infra}); the earlier ${standing.verdict} stands`,
      );
      // Applied as on any read of an unapplied PASS/FAIL (a FAIL loops back, idempotently).
      await this.applyAgentQaVerdict(project, w, key, url, standing.verdict);
      return;
    }
    let prior = applied ?? latest?.verdict;
    let rerun: AgentQaRerun | undefined;
    const infraRetry = this.agentQaInfraRetry.get(key);
    if (
      (prior === "PASS" || prior === "FAIL") &&
      infraRetry &&
      this.clock().getTime() >= infraRetry.at
    ) {
      rerun = { device: true, reason: "a retry after an infrastructure failure" };
    } else if (prior === "PASS" || prior === "FAIL") {
      rerun = await this.agentQaRerun(
        project,
        w,
        key,
        url,
        manual,
        comments,
        prior,
        latest?.inputs,
      );
      if (!rerun) {
        // The report was posted (e.g. by an earlier process) but its effects may not have landed.
        if (!applied) await this.applyAgentQaVerdict(project, w, key, url, prior);
        return;
      }
    } else if (rerunCommentPending(comments)) {
      rerun = { device: true, reason: "a /qa rerun comment" };
    }
    const ticket = await tickets.get(w.ticketId).catch(() => null);
    if (!ticket) return;
    if (ticket.labels.includes(QA_RERUN_LABEL)) {
      // Any device rerun consumes the label too, so it never triggers a second run.
      if (!rerun) rerun = { device: true, reason: `the ${QA_RERUN_LABEL} label`, label: true };
      // The label always asks for a device run, even beside a description change.
      else rerun = { ...rerun, device: true, label: true };
    }
    if (rerun?.label) {
      // Removed when the run starts; a failed removal waits for a later tick (no double run).
      if (!tickets.removeLabel) return;
      try {
        await tickets.removeLabel(w.ticketId, QA_RERUN_LABEL);
      } catch (error) {
        this.trackerFailed(project.id, w.ticketId, "removeLabel", error);
        return;
      }
    }
    // What a re-run may only replace with a real result: an infra failure keeps it (see below).
    const settled =
      rerun && (prior === "PASS" || prior === "FAIL")
        ? { verdict: prior, ...(latest?.inputs ? { inputs: latest.inputs } : {}) }
        : undefined;
    if (rerun) {
      // A fresh verdict replaces the old one; the old BLOCKED wait no longer applies.
      this.agentQaVerdicts.delete(key);
      this.agentQaBlockedSeen.delete(key);
      prior = undefined;
    }
    // An explicit rerun is a human hand-over too: it does not wait for needs-human removal.
    if (!rerun && handedOver && prior === undefined && ticket.labels.includes(NEEDS_HUMAN_LABEL))
      return;
    // A BLOCKED report waits until a human removed needs-human (they fixed the cause).
    if (prior === "BLOCKED" && ticket.labels.includes(NEEDS_HUMAN_LABEL)) {
      this.agentQaBlockedSeen.add(key);
      return;
    }
    // Our own label write never landed: retry it instead of reading its absence as a retry request.
    if (prior === "BLOCKED" && applied === "BLOCKED" && !this.agentQaBlockedSeen.has(key)) {
      await this.trackerWrite(project.id, w.ticketId, "label", async () =>
        tickets.addLabel?.(w.ticketId, NEEDS_HUMAN_LABEL),
      );
      if (tickets.addLabel) return;
    }
    this.agentQaBlockedSeen.delete(key);
    const criteria = qaCriteria(ticket.body, manual.criteria);
    // GitHub-only re-evaluation: the device result for this head is re-used, nothing is rebuilt.
    const stored =
      rerun && !rerun.device
        ? await this.storedDeviceOutcome(qaRun.id, headSha, criteria)
        : undefined;
    const pr = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
    const sources = classifyCriteria(criteria);
    const numbered = (...source: string[]) =>
      sources.flatMap((s, i) => (source.includes(s) ? [i + 1] : []));
    // Code/CI criteria are Matrix's to verify on GitHub (a device agent cannot see them), read
    // again after the device run so the verdict uses CI as it is then, not as it was 2 h earlier.
    const verifyCode = async (): Promise<[CodeCriterionResult[], PullRequestFacts | undefined]> => {
      let facts: PullRequestFacts | undefined;
      let unavailable: string | undefined;
      try {
        facts = await this.o.pullRequests?.facts?.(project, url);
        if (!facts) unavailable = "this Matrix host cannot read the PR on GitHub";
      } catch (error) {
        unavailable = `reading the PR on GitHub failed: ${(error as Error).message.slice(0, 200)}`;
      }
      const checks = await this.latestRun(w, "checks");
      const results = verifyCodeCriteria(
        criteria,
        numbered("github", "both"),
        facts,
        headSha,
        checks
          ? { ok: checks.status === "ok", summary: (checks.summary ?? "").slice(0, 200) }
          : undefined,
        unavailable,
      ).map((r) => ({ ...r, alsoDevice: sources[r.criterion - 1] === "both" }));
      return [results, facts];
    };
    const job = (async () => {
      let outcome: AgentQaOutcome;
      let code: CodeCriterionResult[] = [];
      let facts: PullRequestFacts | undefined;
      if (stored) {
        [code, facts] = await verifyCode();
        await this.finishAgentQa(
          project,
          w,
          key,
          headSha,
          qaRun.id,
          url,
          stored.outcome,
          criteria,
          code,
          {
            images: stored.images,
            inputs: facts ? agentQaInputs(facts.body, criteria) : undefined,
          },
        );
        return;
      }
      try {
        if (!pr?.[1] || !pr[2]) throw new Error("the draft PR is not a GitHub pull request");
        // The PR checklist is these criteria: with none there is nothing a pass could stand on.
        if (!criteria.length) throw new Error(NO_CRITERIA);
        if (!this.o.agentQa?.handles(project))
          throw new Error("no agent QA lane is configured for this project on the Matrix host");
        [, facts] = await verifyCode();
        const surfaces = laneRunSurfaces(project, ticket, manual.surfaces, facts);
        const lane = this.o.agentQa;
        const request = {
          project,
          ticket: {
            id: ticket.id,
            title: ticket.title,
            body: ticket.body,
            comments: comments
              .filter((c) => !c.byMatrix)
              .slice(-20)
              .map((c) => c.body.slice(0, 2_000)),
          },
          pullRequest: { url, number: Number(pr[2]), repo: pr[1] },
          headSha,
          surfaces,
          criteria,
          deviceCriteria: numbered("device", "both"),
          ...(facts ? { pullRequestBody: facts.body.slice(0, 8_000) } : {}),
        };
        // Infra failures (DNS, network, registry 5xx, disk, device offline) are retried with
        // backoff before any verdict: they say nothing about the change.
        const delays = this.o.agentQaInfraRetryDelaysMs ?? [5 * 60_000, 10 * 60_000];
        for (let attempt = 0; ; attempt++) {
          try {
            outcome = await lane.run({ ...request, signal: AbortSignal.timeout(2 * 60 * 60_000) });
          } catch (error) {
            // A lane that throws (SSH, network) is classified and retried like a blocked outcome.
            outcome = { kind: "blocked", reason: (error as Error).message.slice(0, 300) };
          }
          const infra = outcome.kind === "blocked" ? infraFailure(outcome.reason) : undefined;
          const wait = delays[attempt];
          if (!infra || wait === undefined || outcome.kind !== "blocked") break;
          console.error(
            `[agent-qa] ${w.ticketId} ${headSha.slice(0, 12)}: ${infra} failure (try ${attempt + 1}/${delays.length + 1}), retrying in ${Math.round(wait / 60_000)} min: ${outcome.reason.slice(0, 160)}`,
          );
          await (this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(wait);
        }
      } catch (error) {
        outcome = { kind: "blocked", reason: (error as Error).message.slice(0, 300) };
      }
      const infra = outcome.kind === "blocked" ? infraFailure(outcome.reason) : undefined;
      if (infra && settled && outcome.kind === "blocked") {
        const now = facts ? agentQaInputs(facts.body, criteria) : undefined;
        // Same head, same inputs: an infra failure never replaces the PASS/FAIL that stands.
        if (!now || !settled.inputs || now === settled.inputs) {
          const count = (this.agentQaInfraRetry.get(key)?.count ?? 0) + 1;
          const later = this.o.agentQaInfraRecheckMs ?? 30 * 60_000;
          if (count <= 3)
            this.agentQaInfraRetry.set(key, { at: this.clock().getTime() + later, count });
          else this.agentQaInfraRetry.delete(key);
          console.error(
            `[agent-qa] ${w.ticketId} ${headSha.slice(0, 12)}: re-run failed on ${infra}; keeping ${settled.verdict}${count <= 3 ? `, retry ${count}/3 in ${Math.round(later / 60_000)} min` : ", no more retries"}: ${outcome.reason.slice(0, 160)}`,
          );
          await this.keepAgentQaVerdict(project, w, key, url, settled.verdict);
          return;
        }
      }
      this.agentQaInfraRetry.delete(key);
      if (outcome.kind === "report") [code, facts] = await verifyCode();
      await this.finishAgentQa(project, w, key, headSha, qaRun.id, url, outcome, criteria, code, {
        inputs: facts ? agentQaInputs(facts.body, criteria) : undefined,
      });
    })()
      .catch((error) => this.trackerFailed(project.id, w.ticketId, "agent-qa", error))
      .finally(() => this.agentQaJobs.delete(key));
    this.agentQaJobs.set(key, job);
  }

  /**
   * Whether a PASS/FAIL already posted for this head and QA run must be redone: an explicit request
   * (`qa:rerun` label, `/qa rerun` comment) re-runs the device lane; a changed PR description or
   * acceptance criteria re-evaluates the GitHub-checked criteria against the stored device result.
   * A report without an inputs fingerprint (posted before fingerprints existed) is only redone on
   * request. PASS is re-checked at most every 2 minutes; a FAIL is only seen at merge again once a
   * human re-armed the ticket, so it is checked before the FAIL is applied again.
   */
  /**
   * Auto-merge gate (ADR 0007): the project opted in (`deploy.merge: "auto"`), the agent QA lane
   * passed exactly this head for the latest QA run. Review (0 P1) and checks are re-validated by
   * gateProblems; green GitHub checks are re-read by the merge port right before it merges.
   */
  private async autoMergePassed(
    project: ProjectConfig,
    w: WorkflowState,
    headSha: string,
  ): Promise<boolean> {
    if (project.deploy?.merge !== "auto") return false;
    const manual = await this.latestManualQa(w);
    if (manual?.tester !== "agent") return false;
    const qaRun = await this.latestRun(w, "qa");
    if (!qaRun) return false;
    return (
      this.agentQaVerdicts.get(
        `${project.id}\u0000${w.ticketId}\u0000${headSha}\u0000${qaRun.id}`,
      ) === "PASS"
    );
  }

  /** Base syncs per ticket in the last day: a base that keeps moving under a ticket stops here. */
  private readonly baseSyncs = new Map<string, number[]>();

  /**
   * Requeues a merge-waiting workflow after its branch moved onto a newer base (or its head moved
   * after QA). Withdraws pending merge approvals. Retries once on a version race, so a worktree
   * that already moved never stays behind a stale `merge` state; not counted as a review loop,
   * but more than 5 base syncs a day block the ticket for a human.
   */
  private async requeueForBase(
    project: ProjectConfig,
    w: WorkflowState,
    phase: "checks" | "implement",
    reason: string,
  ): Promise<void> {
    const key = `${w.projectId}\u0000${w.ticketId}`;
    const now = this.clock().getTime();
    const recent = (this.baseSyncs.get(key) ?? []).filter((t) => now - t < 86_400_000);
    recent.push(now);
    if (this.baseSyncs.size > 5_000) this.baseSyncs.clear();
    this.baseSyncs.set(key, recent);
    for (const a of await this.o.store.listApprovals(w.projectId, w.ticketId, "merge"))
      if (a.status === "pending")
        await this.o.store
          .decideApproval(
            a.id,
            "rejected",
            { id: this.ownerId, kind: "agent" },
            `superseded: ${reason}`,
          )
          .catch(() => undefined);
    let current: WorkflowState | null = w;
    for (let tries = 0; tries < 2 && current; tries++) {
      if (current.phase !== "merge" || current.status !== "waiting_approval") return;
      const blocked = recent.length > 5;
      const next: WorkflowState = blocked
        ? { ...current, status: "blocked", lastError: `base sync limit (6 in a day): ${reason}` }
        : // New generation: the earlier checks/review/QA steps of this loop never replay.
          {
            ...current,
            phase,
            attempt: 0,
            status: "pending",
            lastError: reason,
            generation: (current.generation ?? 0) + 1,
          };
      delete next.reviewedTree;
      try {
        const saved = await this.o.store.saveWorkflow(next);
        this.o.bus.publish({ type: "workflow.changed", workflow: saved });
        await this.applyEffects(project, saved, {
          state: saved,
          effects: blocked ? [{ type: "blocked", reason: saved.lastError ?? reason }] : [],
        });
        return;
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
        current = await this.o.store.getWorkflow(w.projectId, w.ticketId);
      }
    }
  }

  /** Last external-head check per ticket (one GitHub read per ticket per minute). */
  private readonly externalHeadAt = new Map<string, number>();

  /**
   * A PR head pushed outside Matrix (an agent's rebase, a human fix) is never left untested and
   * never tested stale: the run worktree adopts it and checks, review and QA run again on it.
   * True when the workflow was requeued.
   */
  private async adoptExternalHead(project: ProjectConfig, w: WorkflowState): Promise<boolean> {
    const port = this.o.pullRequests;
    if (!port?.externalHead || !this.o.git.adoptHead || !w.workdir) return false;
    if (w.status !== "waiting_approval") return false;
    const key = `${w.projectId}\u0000${w.ticketId}`;
    const now = this.clock().getTime();
    const last = this.externalHeadAt.get(key);
    if (last !== undefined && now - last < AUTO_MERGE_RETRY_MS) return false;
    if (this.externalHeadAt.size > 5_000) this.externalHeadAt.clear();
    this.externalHeadAt.set(key, now);
    try {
      const external = await port.externalHead(project, w.ticketId);
      if (!external) return false;
      const head = await this.o.git.headSha(w.workdir);
      if (external.headSha === head) return false;
      await this.o.git.adoptHead(w.workdir, external.headSha, external.forkSha);
      await this.requeueForBase(
        (await this.o.store.getProject(project.id)) ?? project,
        w,
        "checks",
        `adopted the PR head ${external.headSha.slice(0, 12)} pushed outside Matrix (Matrix had ${head.slice(0, 12)}); checks, review and QA run again on it`,
      );
      return true;
    } catch (error) {
      this.trackerFailed(project.id, w.ticketId, "adopt-head", error);
      return false;
    }
  }

  /** Last auto-merge attempt per head (throttles retries while CI is still pending). */
  private readonly autoMergeTriedAt = new Map<string, number>();

  /**
   * A merge waiting on its agent QA verdict: once the lane passed this head and every gate still
   * holds, the workflow goes back to pending and the merge phase runs (merge port merges).
   */
  private async maybeAutoMerge(project: ProjectConfig, w: WorkflowState): Promise<void> {
    if (!w.workdir || w.phase !== "merge" || w.status !== "waiting_approval") return;
    const fresh = (await this.o.store.getProject(project.id)) ?? project;
    if (fresh.deploy?.merge !== "auto") return;
    let headSha: string;
    try {
      headSha = await this.o.git.headSha(w.workdir);
    } catch {
      return;
    }
    // A head moved after QA (a rebase whose requeue was lost to a crash or a version race) is
    // never merged and never waited on: checks, review and QA run again on it.
    // Uncommitted changes here can only be an interrupted conflict sync (git conflict markers):
    // Implement resolves and commits them.
    const qa = await this.latestRun(w, "qa");
    const clean = await this.o.git.isClean(w.workdir).catch(() => undefined);
    if (clean === false) {
      await this.requeueForBase(
        fresh,
        w,
        "implement",
        "the run worktree has uncommitted changes while waiting to merge (an interrupted base sync leaves git conflict markers): resolve every conflict marker, keeping the base's newer behaviour plus this ticket's change, and keep the tests passing",
      );
      return;
    }
    if (clean && qa?.headSha && qa.headSha !== headSha) {
      await this.requeueForBase(
        fresh,
        w,
        "checks",
        `the branch head ${headSha.slice(0, 12)} differs from the QA-validated ${qa.headSha.slice(0, 12)}; checks, review and QA run again`,
      );
      return;
    }
    if (!(await this.autoMergePassed(fresh, w, headSha))) return;
    const key = `${project.id}\u0000${w.ticketId}\u0000${headSha}`;
    const now = this.clock().getTime();
    const last = this.autoMergeTriedAt.get(key);
    if (last !== undefined && now - last < AUTO_MERGE_RETRY_MS) return;
    if (this.autoMergeTriedAt.size > 5_000) this.autoMergeTriedAt.clear();
    this.autoMergeTriedAt.set(key, now);
    if (await this.gateProblems(fresh, w, "merge")) return;
    if ((await this.syncWithBase(fresh, w, headSha)) !== "current") return;
    try {
      const saved = await this.o.store.saveWorkflow({ ...w, status: "pending" });
      this.o.bus.publish({ type: "workflow.changed", workflow: saved });
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
    }
  }

  /**
   * Before an auto-merge: a PR that conflicts with its base (or is behind a base that must be up to
   * date) is moved onto the base tip first. A clean rebase changes the code, so checks, review and
   * QA run again on the new head; a conflict goes back to Implement with the markers to resolve.
   * Neither counts as a review loop: nothing was wrong with the change itself.
   */
  private async syncWithBase(
    project: ProjectConfig,
    w: WorkflowState,
    headSha: string,
  ): Promise<"current" | "wait" | "requeued"> {
    const port = this.o.pullRequests;
    if (!port?.baseState || !this.o.git.syncOnto || !w.workdir) return "current";
    let state: Awaited<ReturnType<NonNullable<typeof port.baseState>>>;
    try {
      state = await port.baseState(project, w.ticketId, headSha);
    } catch (error) {
      this.trackerFailed(project.id, w.ticketId, "base-state", error);
      return "wait";
    }
    if (state.kind !== "outdated") return state.kind;
    let result: Awaited<ReturnType<NonNullable<GitPort["syncOnto"]>>>;
    try {
      result = await this.o.git.syncOnto(w.workdir, state.baseSha);
    } catch (error) {
      this.trackerFailed(project.id, w.ticketId, "rebase", error);
      return "wait";
    }
    // GitHub still reports the old head as outdated while the branch already sits on the base tip.
    if (result.kind === "current") return "wait";
    const onto = `${state.base} ${state.baseSha.slice(0, 12)}`;
    const reason =
      result.kind === "rebased"
        ? `rebased onto ${onto} before the merge (${state.reason}); the code changed, so checks, review and QA run again on ${result.headSha.slice(0, 12)}`
        : `the branch conflicts with ${onto} (${state.reason}) in: ${result.files.slice(0, 20).join(", ")}. Matrix re-applied this ticket's change on the new base and left git conflict markers in those files. Resolve every conflict marker, keeping ${state.base}'s newer behaviour plus this ticket's change, and keep the tests passing`;
    await this.requeueForBase(
      project,
      w,
      result.kind === "rebased" ? "checks" : "implement",
      reason,
    );
    return "requeued";
  }

  private async agentQaRerun(
    project: ProjectConfig,
    w: WorkflowState,
    key: string,
    url: string,
    manual: ManualQaData,
    comments: readonly TicketComment[],
    prior: "PASS" | "FAIL",
    recorded: string | undefined,
  ): Promise<AgentQaRerun | undefined> {
    if (rerunCommentPending(comments)) return { device: true, reason: "a /qa rerun comment" };
    const now = this.clock().getTime();
    const last = this.agentQaTriggerAt.get(key);
    // A FAIL whose effects are not applied yet is checked at once (else it loops straight back).
    const settled = prior === "PASS" || this.agentQaVerdicts.has(key);
    if (settled && last !== undefined && now - last < 2 * 60_000) return undefined;
    if (this.agentQaTriggerAt.size > 5_000) this.agentQaTriggerAt.clear();
    this.agentQaTriggerAt.set(key, now);
    const ticket = await this.o
      .tickets(project.id)
      .get(w.ticketId)
      .catch(() => null);
    if (!ticket) return undefined;
    if (ticket.labels.includes(QA_RERUN_LABEL))
      return { device: true, reason: `the ${QA_RERUN_LABEL} label`, label: true };
    if (!recorded) return undefined;
    let body: string;
    try {
      const facts = await this.o.pullRequests?.facts?.(project, url);
      if (!facts) return undefined;
      body = facts.body;
    } catch {
      return undefined;
    }
    if (agentQaInputs(body, qaCriteria(ticket.body, manual.criteria)) === recorded)
      return undefined;
    return { device: false, reason: "the PR description or acceptance criteria changed" };
  }

  /** The device result kept for this head on the QA run, if any. */
  private async storedDeviceOutcome(qaRunId: string, headSha: string, criteria: string[]) {
    const receipts = await this.o.store.listReceipts(qaRunId).catch(() => []);
    for (const r of [...receipts].reverse()) {
      const data = r.data as { provenance?: unknown } | undefined;
      if (r.kind !== "log" || data?.provenance !== AGENT_QA_DEVICE_PROVENANCE) continue;
      const found = deviceOutcomeFromRecord(data, headSha, criteria);
      if (found) return found;
    }
    return undefined;
  }

  private async finishAgentQa(
    project: ProjectConfig,
    started: WorkflowState,
    key: string,
    headSha: string,
    qaRunId: string,
    url: string,
    outcome: AgentQaOutcome,
    criteria: string[],
    code: CodeCriterionResult[],
    opts: { images?: ReadonlyMap<string, string>; inputs?: string | undefined } = {},
  ): Promise<void> {
    const tickets = this.o.tickets(project.id);
    const id = started.ticketId;
    const reused = opts.images !== undefined;
    const images = new Map<string, string>(opts.images ?? []);
    if (!reused && outcome.kind === "report" && tickets.uploadFile)
      for (const shot of outcome.screenshots.slice(0, 12)) {
        try {
          images.set(shot.name, await tickets.uploadFile(id, shot.name, "image/png", shot.bytes));
        } catch (error) {
          this.trackerFailed(project.id, id, "upload-file", error);
        }
      }
    // The workflow moved on while the lane ran (human feedback, new head): the report is stale.
    const now = await this.o.store.getWorkflow(project.id, id);
    if (
      !now ||
      now.status !== "waiting_approval" ||
      now.phase !== "merge" ||
      !now.workdir ||
      (await this.o.git.headSha(now.workdir)) !== headSha ||
      (await this.latestRun(now, "qa"))?.id !== qaRunId
    )
      return;
    const filed =
      outcome.kind === "report"
        ? await this.filePreExisting(project, id, url, headSha, outcome.report)
        : new Map<number, string>();
    // Keep the device result so a later description-only change re-uses it (best effort).
    if (!reused && outcome.kind === "report")
      await this.o.store
        .addReceipts(qaRunId, [
          {
            kind: "log",
            ok: true,
            summary: `agent QA device result for ${headSha.slice(0, 12)}`,
            data: agentQaDeviceRecord(outcome, headSha, images, criteria),
          },
        ])
        .catch((error) => this.trackerFailed(project.id, id, "agent-qa-record", error));
    const rendered = renderAgentQaReport(outcome, {
      headSha,
      qaRun: qaRunId,
      ...(opts.inputs ? { inputs: opts.inputs } : {}),
      pullRequestUrl: url,
      images,
      criteriaCount: criteria.length,
      code,
      criteria,
      filed,
    });
    await this.postAgentQaReport(project, now, key, url, rendered);
  }

  /**
   * Files each pre-existing / environment finding as its own Bug issue (deduped by title against
   * the project's open issues), so it neither fails the PR nor gets lost. Best effort.
   */
  private async filePreExisting(
    project: ProjectConfig,
    ticketId: string,
    url: string,
    headSha: string,
    report: Extract<AgentQaOutcome, { kind: "report" }>["report"],
  ): Promise<Map<number, string>> {
    const filed = new Map<number, string>();
    const found = report.findings.map((f, i) => [f, i] as const).filter(([f]) => isPreExisting(f));
    if (!found.length) return filed;
    const tickets = this.o.tickets(project.id);
    let open: { id: string; title: string }[];
    try {
      open = (
        await tickets.list({ status: ["open", "ready", "in_progress", "blocked", "review", "qa"] })
      ).filter((t) => t.title.startsWith(PRE_EXISTING_PREFIX));
    } catch (error) {
      this.trackerFailed(project.id, ticketId, "list-tickets", error);
      return filed;
    }
    for (const [f, i] of found.slice(0, 5)) {
      const issue = preExistingIssue(f, { ticketId, pullRequestUrl: url, headSha });
      const known = open.find((t) => sameIssueTitle(t.title, issue.title));
      if (known) {
        filed.set(i, known.id);
        continue;
      }
      try {
        const created = await tickets.create({ ...issue, labels: ["Bug"] });
        open.push(created);
        filed.set(i, created.id);
      } catch (error) {
        this.trackerFailed(project.id, ticketId, "create-ticket", error);
      }
    }
    return filed;
  }

  /**
   * The report comment is the durable record (effects are re-applied from it after a restart), so
   * nothing is applied before it is posted; a failed post is retried on later ticks.
   */
  private async postAgentQaReport(
    project: ProjectConfig,
    w: WorkflowState,
    key: string,
    url: string,
    report: { body: string; verdict: AgentQaVerdict },
  ): Promise<void> {
    try {
      await this.o.tickets(project.id).comment(w.ticketId, report.body);
    } catch (error) {
      if (this.agentQaUnposted.size > 1_000) this.agentQaUnposted.clear();
      this.agentQaUnposted.set(key, report);
      this.trackerFailed(project.id, w.ticketId, "comment", error);
      return;
    }
    this.agentQaUnposted.delete(key);
    await this.applyAgentQaVerdict(project, w, key, url, report.verdict);
  }

  /**
   * Labels (ticket + PR) and, on FAIL, the loop back to implement. Idempotent; the verdict is
   * recorded as applied only once every effect succeeded, so a later tick retries the rest.
   */
  private async applyAgentQaVerdict(
    project: ProjectConfig,
    now: WorkflowState,
    key: string,
    url: string,
    verdict: AgentQaVerdict,
  ): Promise<void> {
    try {
      await this.applyAgentQaEffects(project, now, url, verdict);
      this.agentQaVerdicts.set(key, verdict);
    } catch (error) {
      this.trackerFailed(project.id, now.ticketId, "agent-qa-verdict", error);
    }
  }

  /**
   * Re-asserts a PASS/FAIL that an infra failure must not replace, recorded as applied. A kept
   * PASS is applied as usual (labels only); a kept FAIL only gets its labels back, since its loop
   * back to implement happened when it was first applied.
   */
  private async keepAgentQaVerdict(
    project: ProjectConfig,
    w: WorkflowState,
    key: string,
    url: string,
    verdict: "PASS" | "FAIL",
  ): Promise<void> {
    if (verdict === "PASS") {
      await this.applyAgentQaVerdict(project, w, key, url, verdict);
      return;
    }
    try {
      await this.writeAgentQaLabels(project, {
        id: this.ids(),
        projectId: project.id,
        ticketId: w.ticketId,
        url,
        ticket: { add: [QA_FAILED_LABEL], remove: [QA_PASSED_LABEL] },
        pr: { add: [QA_FAILED_LABEL], remove: [QA_PASSED_LABEL] },
        tries: 0,
      });
      this.agentQaVerdicts.set(key, verdict);
    } catch (error) {
      this.trackerFailed(project.id, w.ticketId, "agent-qa-verdict", error);
    }
  }

  private async applyAgentQaEffects(
    project: ProjectConfig,
    now: WorkflowState,
    url: string,
    verdict: AgentQaVerdict,
  ): Promise<void> {
    const fix = (ticket: [string[], string[]], pr: [string[], string[]]): AgentQaLabelFix => ({
      id: this.ids(),
      projectId: project.id,
      ticketId: now.ticketId,
      url,
      ticket: { add: ticket[0], remove: ticket[1] },
      pr: { add: pr[0], remove: pr[1] },
      tries: 0,
    });
    if (verdict === "PASS") {
      await this.writeAgentQaLabels(
        project,
        fix(
          [[QA_PASSED_LABEL], [QA_FAILED_LABEL, NEEDS_HUMAN_LABEL]],
          [[QA_PASSED_LABEL], [QA_FAILED_LABEL]],
        ),
      );
      return;
    }
    if (verdict === "BLOCKED") {
      // Recorded even if labelling fails (retried every tick): a BLOCKED head must never re-run
      // on every tick. An earlier head's pass must not keep advertising itself.
      await this.writeAgentQaLabels(
        project,
        fix([[NEEDS_HUMAN_LABEL], [QA_PASSED_LABEL]], [[], [QA_PASSED_LABEL]]),
      );
      return;
    }
    // The loop back is what matters; labels follow it and are retried until they land.
    const saved = await this.loopBackFromQa(
      project,
      now,
      "agent QA failed on the draft PR; fix the findings in the agent QA report comment",
      "agent QA failed",
    );
    // Lost a race with another writer: not applied, the next tick re-reads and retries.
    if (!saved) throw new Error("workflow changed while applying the agent QA FAIL; retrying");
    await this.writeAgentQaLabels(
      project,
      fix([[QA_FAILED_LABEL], [QA_PASSED_LABEL]], [[QA_FAILED_LABEL], [QA_PASSED_LABEL]]),
    );
  }

  /**
   * Writes one verdict's labels (ticket, then PR). Removals go first, so a write failing midway
   * never leaves `qa:passed` beside a FAIL; a failure queues the whole fix for the next tick. A
   * newer verdict for the ticket replaces any queued fix.
   */
  private async writeAgentQaLabels(project: ProjectConfig, fix: AgentQaLabelFix): Promise<void> {
    const k = `${fix.projectId}\u0000${fix.ticketId}`;
    // A newer verdict for the ticket supersedes any older fix, queued or in flight.
    if (fix.tries === 0) {
      if (this.agentQaLabelsLatest.size > 5_000)
        for (const old of this.agentQaLabelsLatest.keys())
          if (!this.agentQaLabelsPending.has(old)) this.agentQaLabelsLatest.delete(old);
      if (this.agentQaLabelsBackoff.size > 5_000)
        for (const old of this.agentQaLabelsBackoff.keys())
          if (!this.agentQaLabelsPending.has(old)) this.agentQaLabelsBackoff.delete(old);
      this.agentQaLabelsLatest.set(k, fix);
      // A new verdict is written now, whatever an older one's backoff said.
      this.agentQaLabelsBackoff.delete(k);
      // Write-ahead: a restart mid-write resumes it (label writes are idempotent).
      await this.queueLabelRetryOp(fix, "persist", (st, f) => st.saveLabelRetry(f));
    }
    if (this.agentQaLabelsLatest.get(k) !== fix) return;
    this.agentQaLabelsPending.delete(k);
    const tickets = this.o.tickets(project.id);
    try {
      // Ticket labels that landed are never rewritten by a PR-label retry: a human may have
      // removed needs-human since (their "re-run" signal).
      if (!fix.ticketDone) {
        for (const l of fix.ticket.remove) await tickets.removeLabel?.(fix.ticketId, l);
        for (const l of fix.ticket.add) await tickets.addLabel?.(fix.ticketId, l);
        fix.ticketDone = true;
      }
      await this.o.pullRequests?.label?.(project, fix.url, fix.pr.add, fix.pr.remove);
    } catch (error) {
      fix.tries += 1;
      // Kept until it lands or a newer verdict replaces it (one entry per ticket at most).
      if (this.agentQaLabelsLatest.get(k) === fix) {
        this.agentQaLabelsPending.set(k, fix);
        // Progress only: never overwrites (or resurrects) a newer verdict's row.
        await this.queueLabelRetryOp(fix, "persist", (st, f) => st.updateLabelRetry(f));
      }
      const now = this.clock().getTime();
      const permanent = isPermissionFailure(error);
      const prev = this.agentQaLabelsBackoff.get(k);
      const cap = permanent ? LABEL_RETRY_PERMANENT_CAP_MS : LABEL_RETRY_CAP_MS;
      const delay = Math.min(cap, LABEL_RETRY_BASE_MS * 2 ** Math.min(fix.tries - 1, 20));
      const log = !permanent || prev?.loggedAt === undefined || now - prev.loggedAt >= HOUR_MS;
      const loggedAt = log ? now : prev?.loggedAt;
      // Only the ticket's newest fix sets its backoff (an older one failing late never delays it).
      if (this.agentQaLabelsLatest.get(k) === fix)
        this.agentQaLabelsBackoff.set(k, {
          nextAt: now + delay,
          ...(loggedAt !== undefined ? { loggedAt } : {}),
        });
      if (log) this.trackerFailed(project.id, fix.ticketId, "agent-qa-labels", error);
      return;
    }
    // An older write landing late never clears the newer fix's backoff.
    if (this.agentQaLabelsLatest.get(k) === fix) this.agentQaLabelsBackoff.delete(k);
    // Only this fix's row: a newer verdict's queued write stays. A leftover row only replays
    // idempotent label writes after a restart.
    await this.queueLabelRetryOp(fix, "dequeue", (st, f) =>
      st.deleteLabelRetry(f.projectId, f.ticketId, f.id),
    );
  }

  /**
   * Runs one label-retry store write after the ticket's previous ones (they land in the order
   * they were issued, so an older verdict's write never lands after a newer one's). Best effort:
   * the in-memory queue still retries if the store is down.
   */
  private async queueLabelRetryOp(
    fix: AgentQaLabelFix,
    what: "persist" | "dequeue",
    op: (store: Store, snapshot: AgentQaLabelFix) => Promise<void>,
  ): Promise<void> {
    const k = `${fix.projectId}\u0000${fix.ticketId}`;
    const snapshot = structuredClone(fix);
    const run = (this.labelRetryOps.get(k) ?? Promise.resolve()).then(async () => {
      try {
        await op(this.o.store, snapshot);
      } catch (error) {
        this.trackerFailed(fix.projectId, fix.ticketId, `agent-qa-labels-${what}`, error);
      }
    });
    this.labelRetryOps.set(k, run);
    await run;
    if (this.labelRetryOps.get(k) === run) this.labelRetryOps.delete(k);
  }

  /**
   * Once per process: reloads label writes queued by an earlier process (lost on restart
   * otherwise). A fix this process already made for the ticket is newer and wins.
   */
  private async resumeAgentQaLabels(): Promise<void> {
    if (this.agentQaLabelsResumed) return;
    let queued: LabelRetry[];
    try {
      queued = await this.o.store.listLabelRetries();
    } catch (error) {
      this.o.bus.publish({
        type: "tracker.failed",
        projectId: "*",
        ticketId: "*",
        operation: "agent-qa-labels-resume",
        message: error instanceof Error ? error.message : String(error),
        at: this.clock().toISOString(),
      });
      return;
    }
    this.agentQaLabelsResumed = true;
    for (const fix of queued) {
      const k = `${fix.projectId}\u0000${fix.ticketId}`;
      if (this.agentQaLabelsLatest.has(k)) continue;
      // Not a new verdict: the retry path must not re-persist or re-supersede it.
      const resumed = { ...fix, tries: Math.max(1, fix.tries) };
      this.agentQaLabelsLatest.set(k, resumed);
      this.agentQaLabelsPending.set(k, resumed);
    }
  }

  /** True when Matrix already posted the handoff comment for this PR (e.g. an earlier process). */
  private async announced(project: ProjectConfig, ticketId: string, url: string): Promise<boolean> {
    const tickets = this.o.tickets(project.id);
    if (!tickets.listComments) return false;
    try {
      return (await tickets.listComments(ticketId)).some(
        (c) =>
          c.byMatrix && c.body.startsWith("Matrix needs a human: manual") && c.body.includes(url),
      );
    } catch {
      return false;
    }
  }

  /** Labels the ticket needs-human and says why, once per published head (tracker best effort). */
  private async announceManualQa(
    project: ProjectConfig,
    w: WorkflowState,
    manual: ManualQaData,
    url: string,
  ): Promise<void> {
    const tickets = this.o.tickets(project.id);
    const reason = manualQaReason(manual.surfaces);
    if (tickets.addLabel)
      await this.trackerWrite(project.id, w.ticketId, "addLabel", async () =>
        tickets.addLabel?.(w.ticketId, NEEDS_HUMAN_LABEL),
      );
    const link = /^https:\/\/[^\s()<>[\]`"']{1,500}$/.test(url) ? url : "(see the status comment)";
    await this.trackerWrite(project.id, w.ticketId, "comment", () =>
      tickets.comment(
        w.ticketId,
        [
          `Matrix needs a human: ${reason}: ${link}`,
          "Checks and review passed; no driver for this surface runs on the Matrix host. Test the draft PR on a device with the checklist in its description, then approve the merge in Matrix. To request changes instead, comment here and move the ticket back to Ready: the next run treats your comments as review feedback.",
        ].join("\n\n"),
      ),
    );
  }

  /** The handoff of the latest QA run, when QA was handed off to a human. */
  private async latestManualQa(w: WorkflowState): Promise<ManualQaData | undefined> {
    const run = await this.latestRun(w, "qa");
    if (!run || run.status !== "ok") return undefined;
    return (await this.o.store.listReceipts(run.id)).map(manualQaData).find((d) => d);
  }

  private isActive(w: WorkflowState): boolean {
    return [...this.active.values()].some(
      (r) => r.projectId === w.projectId && r.ticketId === w.ticketId,
    );
  }

  private async syncReady(project: ProjectConfig): Promise<void> {
    if (this.o.withTicketSnapshotLock)
      return this.o.withTicketSnapshotLock(project.id, () => this.syncReadyLocked(project));
    return this.syncReadyLocked(project);
  }

  private async syncReadyLocked(project: ProjectConfig): Promise<void> {
    const store = this.o.tickets(project.id);
    for (const t of await store.ready()) {
      await this.o.store.indexTicket(project.id, {
        id: t.id,
        title: t.title,
        status: t.status,
        labels: t.labels,
        ...(t.priority !== undefined ? { priority: t.priority } : {}),
        ...(t.url ? { url: t.url } : {}),
        snapshot: t,
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
      } else if (!(await this.manualQaFeedback(project, t.id))) {
        await this.requeue(project, t.id, t.priority);
      }
    }
  }

  /** Aborts a run this reconciler executes, as a human stop; false when it is not local. */
  abortRun(runId: string, reason: string): boolean {
    const run = this.active.get(runId);
    run?.controller.abort(new HumanStopError(reason));
    return run !== undefined;
  }

  /** A ticket a human moved back to Backlog/Todo while its workflow is active stops it. */
  private async honorStopRequests(project: ProjectConfig): Promise<void> {
    const tickets = this.o.tickets(project.id);
    if (!tickets.stopRequests) return;
    const active = (await this.o.store.listWorkflows({ status: [...ACTIVE_STATUSES] })).filter(
      (w) => w.projectId === project.id,
    );
    if (!active.length) return;
    let requests: { id: string; column: string }[];
    try {
      requests = await tickets.stopRequests(active.map((w) => w.ticketId));
    } catch (error) {
      this.trackerFailed(project.id, "*", "stop-requests", error);
      return;
    }
    for (const r of requests)
      await this.stopWorkflow(project.id, r.id, `${HUMAN_STOP} (moved to ${r.column})`);
  }

  /**
   * Stops an active workflow on a human's request: aborts its run when this reconciler runs it
   * (the runner kills the container / Orca terminal), marks the run cancelled, and blocks the
   * workflow with `reason`. No attempt or restart budget is consumed and the ticket is never
   * moved; moving it to Ready later restarts it. Returns null when nothing was active.
   */
  async stopWorkflow(
    projectId: string,
    ticketId: string,
    reason: string,
  ): Promise<WorkflowState | null> {
    let saved: WorkflowState | undefined;
    let runId: string | undefined;
    for (let tries = 0; !saved && tries < 3; tries++) {
      const w = await this.o.store.getWorkflow(projectId, ticketId);
      if (!w || !(ACTIVE_STATUSES as readonly string[]).includes(w.status)) return null;
      const next: WorkflowState = {
        ...w,
        status: "blocked",
        lastError: reason,
        stoppedBy: "human",
      };
      for (const key of ["leaseOwner", "leaseExpiresAt", "nextAttemptAt", "currentRunId"] as const)
        delete next[key];
      try {
        saved = await this.o.store.saveWorkflow(next);
        runId = w.status === "running" ? w.currentRunId : undefined;
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
      }
    }
    if (!saved) return null;
    const local = [...this.active.values()].find(
      (r) => r.projectId === projectId && r.ticketId === ticketId,
    );
    if (local) local.controller.abort(new HumanStopError(reason));
    // A run owned elsewhere (or orphaned) is closed here; its owner is fenced when it finishes.
    else if (runId)
      await this.o.store.updateRun(runId, {
        status: "cancelled",
        finishedAt: this.clock(),
        summary: reason,
      });
    this.quotaDeferrals.delete(`${projectId}\u0000${ticketId}`);
    this.o.bus.publish({ type: "workflow.changed", workflow: saved });
    await this.trackerWrite(projectId, ticketId, "comment", () =>
      this.o
        .tickets(projectId)
        .comment(
          ticketId,
          `Matrix ${reason}. The current run was cancelled; nothing else changed. Move the ticket to Ready to restart it at ${saved.phase} (does not count against the daily restart limit).`,
        ),
    );
    return saved;
  }

  /**
   * A blocked ticket showing up as ready again means a human re-queued it: restart the workflow
   * in its phase with fresh attempt/loop budgets (new generation, so no stale step replays) and
   * drop the needs-human label. Flapping is capped per UTC day; the cap is announced once.
   */
  private async requeue(
    project: ProjectConfig,
    ticketId: string,
    priority: number | undefined,
  ): Promise<void> {
    const w = await this.o.store.getWorkflow(project.id, ticketId);
    if (!w || w.status !== "blocked") return;
    const tickets = this.o.tickets(project.id);
    const now = this.clock();
    const today = w.requeuedAt?.toISOString().slice(0, 10) === this.day();
    const count = today ? (w.requeueCount ?? 0) : 0;
    // A human stopped it on purpose: resuming it is not flapping and costs no restart budget.
    const afterStop = w.stoppedBy === "human";
    try {
      if (!afterStop && count >= this.maxRequeues) {
        if (count > this.maxRequeues) return;
        await this.o.store.saveWorkflow({ ...w, requeueCount: count + 1 });
        await this.trackerWrite(project.id, ticketId, "comment", () =>
          tickets.comment(
            ticketId,
            `Matrix did not restart this ticket: it was re-queued ${count} times today (limit ${this.maxRequeues}). It stays blocked until tomorrow (UTC).`,
          ),
        );
        return;
      }
      const next: WorkflowState = {
        ...w,
        status: "pending",
        attempt: 0,
        // Irreversible phases keep `loops`: it is part of their action key, so a merge/deploy
        // whose result was lost dedupes downstream instead of running twice.
        loops: IRREVERSIBLE.has(w.phase) ? w.loops : 0,
        priority: priority ?? w.priority,
        generation: (w.generation ?? 0) + 1,
        ...(afterStop ? {} : { requeuedAt: now, requeueCount: count + 1 }),
      };
      for (const key of ["lastError", "nextAttemptAt", "leaseOwner", "leaseExpiresAt"] as const)
        delete next[key];
      delete next.currentRunId;
      delete next.stoppedBy;
      const saved = await this.o.store.saveWorkflow(next);
      this.quotaDeferrals.delete(`${project.id}\u0000${ticketId}`);
      // The move to Ready was this restart, not QA feedback on the handoff it restarts at.
      const prefix = `${project.id}\u0000${ticketId}\u0000`;
      for (const k of this.handoffLeftReady)
        if (k.startsWith(prefix)) this.handoffLeftReady.delete(k);
      this.o.bus.publish({ type: "workflow.changed", workflow: saved });
    } catch (error) {
      if (error instanceof VersionConflictError) return;
      throw error;
    }
    if (tickets.removeLabel)
      await this.trackerWrite(project.id, ticketId, "removeLabel", async () =>
        tickets.removeLabel?.(ticketId, NEEDS_HUMAN_LABEL),
      );
    await this.trackerWrite(project.id, ticketId, "comment", () =>
      tickets.comment(
        ticketId,
        afterStop
          ? `Matrix restarted this ticket at ${w.phase} after a human stop (no restart budget used).`
          : `Matrix restarted this ticket at ${w.phase} (restart ${count + 1} of ${this.maxRequeues} today).`,
      ),
    );
  }

  /** Blocks a not-yet-running workflow for a human (per-ticket caps). */
  private async blockForHuman(
    project: ProjectConfig,
    w: WorkflowState,
    reason: string,
  ): Promise<void> {
    let saved: WorkflowState;
    try {
      saved = await this.o.store.saveWorkflow({ ...w, status: "blocked", lastError: reason });
    } catch (error) {
      if (error instanceof VersionConflictError) return;
      throw error;
    }
    await this.applyEffects(project, saved, {
      state: saved,
      effects: [{ type: "blocked", reason }],
    });
  }

  private async modelFor(project: ProjectConfig, workflow: WorkflowState): Promise<string> {
    return (await this.phaseModel(project, workflow)).model;
  }

  private async phaseModel(
    project: ProjectConfig,
    workflow: WorkflowState,
  ): Promise<{ model: string; provider: string | undefined; runner: RunnerId }> {
    const ticket = await this.o.tickets(project.id).get(workflow.ticketId);
    const selected = selectModel(project, workflow.phase, ticket ?? undefined);
    const model = resolveModel(project, selected.model);
    const provider = MODEL_PHASES.has(workflow.phase)
      ? providerOf(selected.runner, model)
      : undefined;
    return { model, provider, runner: selected.runner };
  }

  private async blockedBy(project: ProjectConfig, w: WorkflowState): Promise<string | null> {
    const runs = [...this.active.values()];
    const { model, provider } = await this.phaseModel(project, w);
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
    const onHost = runs.filter((r) => r.host === project.host);
    if (onHost.length >= hostLimit) return `host limit ${project.host}`;
    const heavyLimit = limits.heavyPerHost?.[project.host] ?? limits.defaultHeavyPerHost;
    if (
      heavyLimit !== undefined &&
      HEAVY_PHASES.has(w.phase) &&
      onHost.filter((r) => HEAVY_PHASES.has(r.phase)).length >= heavyLimit
    )
      return `heavy limit ${project.host}`;
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
    const quota = await this.quotaBlock(provider);
    if (quota || !provider || !this.o.gatewayReady) return quota;
    return this.o.gatewayReady(model);
  }

  /** Subscription quota: provider cooldown, concurrency, hourly runs and 5h runner minutes. */
  private async quotaBlock(provider: string | undefined): Promise<string | null> {
    const policy = this.o.quota;
    if (!policy || !this.cooldowns || !provider) return null;
    const now = this.clock();
    const cooldown = this.cooldowns.active(provider, now);
    if (cooldown) return `quota cooldown ${provider} until ${cooldown.until.toISOString()}`;
    const limits = quotaFor(policy, provider);
    const active = [...this.active.values()].filter((r) => r.provider === provider).length;
    if (active >= limits.maxConcurrent) return `quota concurrency ${provider}`;
    const usage = await this.providerUsage();
    if ((usage.runsLastHour.get(provider) ?? 0) >= limits.maxRunsPerHour)
      return `quota hourly runs ${provider}`;
    if ((usage.minutes5h.get(provider) ?? 0) >= limits.maxRunnerMinutesPer5h)
      return `quota 5h runner minutes ${provider}`;
    return null;
  }

  /** Rolling usage per provider from the run log; cached until the next dispatch or tick. */
  private providerUsage(): Promise<ProviderUsage> {
    this.usage ??= (async () => {
      const now = this.clock().getTime();
      const usage: ProviderUsage = { runsLastHour: new Map(), minutes5h: new Map() };
      for (const run of await this.o.store.listRuns()) {
        const started = run.startedAt.getTime();
        const end = run.finishedAt?.getTime() ?? now;
        if (end < now - FIVE_HOURS_MS || !MODEL_PHASES.has(run.phase)) continue;
        const provider = providerOf(run.runner, run.model);
        if (started >= now - HOUR_MS)
          usage.runsLastHour.set(provider, (usage.runsLastHour.get(provider) ?? 0) + 1);
        const minutes = (end - Math.max(started, now - FIVE_HOURS_MS)) / 60_000;
        usage.minutes5h.set(provider, (usage.minutes5h.get(provider) ?? 0) + Math.max(0, minutes));
      }
      return usage;
    })();
    return this.usage;
  }

  /**
   * Per-ticket budget since the last (re)queue: dollars when the runs report spend, otherwise
   * runner minutes. Exceeding it blocks the ticket for a human instead of burning quota.
   */
  private async ticketCapReason(project: ProjectConfig, w: WorkflowState): Promise<string | null> {
    const minutesCap = this.o.quota?.perTicketRunnerMinutes;
    if (project.perTicketBudgetUsd === undefined && minutesCap === undefined) return null;
    // Only gate work that would spend more: finished model work never blocks a merge or deploy.
    if (!MODEL_PHASES.has(w.phase)) return null;
    const since = w.requeuedAt?.getTime() ?? 0;
    const now = this.clock().getTime();
    const runs = (
      await this.o.store.listRuns({ projectId: w.projectId, ticketId: w.ticketId })
    ).filter((run) => run.startedAt.getTime() >= since);
    const modelRuns = runs.filter((run) => MODEL_PHASES.has(run.phase));
    const spent = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
    if (project.perTicketBudgetUsd !== undefined && spent > 0) {
      return spent >= project.perTicketBudgetUsd
        ? `per-ticket budget reached ($${spent.toFixed(2)} of $${project.perTicketBudgetUsd})`
        : null;
    }
    if (minutesCap === undefined) return null;
    const minutes = modelRuns.reduce(
      (sum, run) => sum + ((run.finishedAt?.getTime() ?? now) - run.startedAt.getTime()) / 60_000,
      0,
    );
    return minutes >= minutesCap
      ? `per-ticket runner time reached (${Math.round(minutes)} of ${minutesCap} min)`
      : null;
  }

  /** Current quota state per provider (limits, usage, cooldown), for the API and dashboard. */
  async quotaStatus(): Promise<QuotaStatus[]> {
    const policy = this.o.quota;
    if (!policy || !this.cooldowns) return [];
    this.usage = undefined;
    const usage = await this.providerUsage();
    const now = this.clock();
    const providers = new Set([
      ...Object.keys(policy.providers),
      ...usage.runsLastHour.keys(),
      ...usage.minutes5h.keys(),
      ...this.cooldowns.list().map((c) => c.provider),
      ...[...this.active.values()].flatMap((r) => (r.provider ? [r.provider] : [])),
    ]);
    return [...providers].sort().map((provider) => {
      const cooldown = this.cooldowns?.active(provider, now);
      return {
        provider,
        limits: quotaFor(policy, provider),
        active: [...this.active.values()].filter((r) => r.provider === provider).length,
        runsLastHour: usage.runsLastHour.get(provider) ?? 0,
        runnerMinutes5h: Math.round(usage.minutes5h.get(provider) ?? 0),
        ...(cooldown ? { cooldown: publicCooldown(cooldown) } : {}),
      };
    });
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
    const run = await this.latestRun(
      w,
      phase === "design" ? "design" : phase === "merge" ? "qa" : "merge",
    );
    return phase === "design" && run?.stepKey !== stepKey(w) ? undefined : run;
  }

  private async designRequired(project: ProjectConfig, w: WorkflowState): Promise<boolean> {
    if (!project.agents?.designFirst) return false;
    if (await this.latestRun(w, "design")) return true;
    return (await this.designScope(project, w)).required;
  }

  private async designScope(
    project: ProjectConfig,
    w: WorkflowState,
    planned?: string[],
  ): Promise<DesignScope> {
    const ticket = await this.o.tickets(project.id).get(w.ticketId);
    if (!ticket) throw new Error("ticket is missing for host UI classification");
    const spike = await this.latestRun(w, "spike");
    const receipts = spike ? await this.o.store.listReceipts(spike.id) : [];
    const paths = receipts.flatMap((receipt) => {
      const data = receipt.data as { provenance?: string; affectedPaths?: unknown } | undefined;
      if (receipt.kind !== "log" || !receipt.ok || data?.provenance !== "matrix:spike-plan:v1")
        return [];
      const parsed = spikePlanSchema.safeParse({
        plan: "recorded",
        affectedPaths: data.affectedPaths,
      });
      return parsed.success ? parsed.data.affectedPaths : [];
    });
    let context: unknown;
    try {
      context = await this.o.uiContext?.inspect(project, w);
    } catch {
      context = undefined;
    }
    return classifyDesignScope(ticket, planned ?? paths, context);
  }

  private async verifiedDesign(
    project: ProjectConfig,
    w: WorkflowState,
  ): Promise<DesignEvidence[]> {
    const run = await this.latestRun(w, "design");
    if (!run || run.status !== "ok" || !run.headSha)
      throw new Error("missing successful design run");
    const receipts = await this.o.store.listReceipts(run.id);
    if (!gate("design", { ok: true, summary: "", receipts }, project).pass)
      throw new Error("invalid design receipts");
    const evidence = receipts
      .filter((receipt) => receipt.kind === "design")
      .map((receipt) => designEvidence(receipt)!);
    if (
      evidence.some(
        (item) =>
          item.runId !== run.id ||
          item.projectId !== project.id ||
          item.ticketId !== w.ticketId ||
          item.headSha !== run.headSha ||
          item.model !== run.model ||
          item.runner !== run.runner,
      )
    )
      throw new Error("design evidence scope mismatch");
    const capability = this.o.handlers.getDesignCapability?.(project);
    if (
      !project.design ||
      !capability ||
      figmaConfigurationHash(capability) !== capability.configurationSha256
    )
      throw new Error("current Figma MCP configuration cannot be verified");
    const fileIdentity = canonicalFigmaFile(project.design.figmaFileUrl);
    if (
      evidence.some(
        (item) =>
          item.fileIdentity !== fileIdentity ||
          canonicalFigmaFile(item.frameUrl) !== fileIdentity ||
          item.configurationSha256 !== capability.configurationSha256 ||
          item.runner !== project.models.design?.runner ||
          item.model !== project.models.design?.model,
      )
    )
      throw new DesignBindingChangedError(
        "Figma file or runner MCP configuration changed; new design and approval required",
      );
    return evidence;
  }

  private async approvedDesign(
    project: ProjectConfig,
    w: WorkflowState,
  ): Promise<DesignEvidence[]> {
    const evidence = await this.verifiedDesign(project, w);
    if (requiresApproval(autonomyFor(project, "design"), "design")) {
      const run = (await this.latestRun(w, "design"))!;
      const { approved } = await this.approvalFor(w, "design", run.id, run.headSha!);
      if (!approved) throw new Error("design requires a human approval bound to its phase/run/SHA");
    }
    return evidence;
  }

  private async approvalFor(
    w: WorkflowState,
    phase: Phase,
    runId: string,
    headSha: string,
  ): Promise<{ approved?: ApprovalRecord | undefined; pending?: ApprovalRecord | undefined }> {
    // Filter on phase here too: an approval for another phase (e.g. `review`) must never
    // authorize a merge or deploy, even if a store adapter returns more than asked for.
    const list = (await this.o.store.listApprovals(w.projectId, w.ticketId, phase)).filter(
      (a) => a.phase === phase && a.projectId === w.projectId && a.ticketId === w.ticketId,
    );
    const bound = list.filter((a) => a.runId === runId && a.headSha === headSha);
    const runOwner = (await this.o.store.getRun(runId))?.ownerId;
    return {
      approved: bound
        .filter((a) => a.status === "approved")
        .filter((a) => validApprover(a, runOwner))
        .at(-1),
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
    if (!run)
      throw new Error(
        `no ${phase === "design" ? "design" : phase === "merge" ? "qa" : "merge"} run to approve`,
      );
    const headSha = await this.o.git.headSha(w.workdir);
    if (phase === "design" && run.headSha !== headSha)
      throw new Error("design commit changed before approval request");
    const existing = await this.approvalFor(w, phase, run.id, headSha);
    if (phase === "merge") await this.publishPullRequest(project, w);
    if (existing.pending?.runId === run.id && existing.pending.headSha === headSha) return;
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

    // A manual QA handoff always needs a merge approval, whatever the autonomy setting,
    // except the auto-merge gate: the agent QA lane passed exactly this head (ADR 0007).
    const manual =
      phase === "merge" &&
      (await this.latestManualQa(w)) !== undefined &&
      !(await this.autoMergePassed(fresh, w, headSha));
    if (requiresApproval(mode, phase) || manual) {
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
    if (await this.designRequired(project, w)) {
      try {
        await this.approvedDesign(project, w);
      } catch (error) {
        return (error as Error).message;
      }
    }
    const needed: Phase[] =
      phase === "merge" ? ["checks", "review", "qa"] : ["checks", "review", "qa", "merge"];
    if (!w.workdir) return "no workspace";
    if (!(await this.o.git.isClean(w.workdir))) return "worktree has uncommitted changes";
    const head = await this.o.git.headSha(w.workdir);
    for (const p of needed) {
      const run = await this.latestRun(w, p);
      if (!run) return `missing ${p} run`;
      if (run.status !== "ok") return `latest ${p} run is ${run.status}`;
      if (run.headSha !== head) {
        return `${p} validated ${run.headSha?.slice(0, 12) ?? "no commit"}, HEAD is ${head.slice(0, 12)}`;
      }
      if (p === "merge") continue;
      const receipts = await this.o.store.listReceipts(run.id);
      const manual = p === "qa" ? receipts.map(manualQaData).find((d) => d) : undefined;
      if (manual && !manualQaStillAllowed(project, manual))
        return "manual QA handoff is no longer allowed by the project's qa config";
      if (p === "qa" && !manual && !receipts.some(isTrustedHoldout))
        return "QA has no judge-produced holdout score";
      const result = gate(p, { ok: true, summary: "", receipts }, project);
      if (!result.pass) return `${p} gate no longer passes: ${result.reason}`;
      if (p === "qa" && (await this.designRequired(project, w))) {
        const designs = await this.approvedDesign(project, w);
        const comparison = receipts
          .filter((receipt) => receipt.kind === "screenshot" && receipt.ok)
          .map((receipt) => designComparisonSchema.safeParse(receipt.data))
          .find(
            (parsed) =>
              parsed.success &&
              parsed.data.matches &&
              parsed.data.runId === run.id &&
              parsed.data.headSha === run.headSha &&
              parsed.data.projectId === project.id &&
              parsed.data.ticketId === w.ticketId &&
              parsed.data.designs.length === designs.length &&
              designs.every((design) =>
                parsed.data.designs.some(
                  (reference) =>
                    reference.runId === design.runId &&
                    reference.frameUrl === design.frameUrl &&
                    reference.contentSha256 === design.contentSha256 &&
                    reference.screenshot.sha256 === design.screenshot.sha256,
                ),
              ),
          );
        if (!comparison)
          return "QA has no host-produced screenshot comparison against approved designs";
      }
    }
    const checks = await this.latestRun(w, "checks");
    for (const p of ["review", "qa"] as const) {
      const run = await this.latestRun(w, p);
      if (run && checks && run.headSha !== checks.headSha) {
        return `${p} ran on a different commit than checks`;
      }
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
    project = (await this.o.store.getProject(project.id)) ?? project;
    if (w.phase === "design") {
      const run = await this.latestRun(w, "design");
      if (run?.status === "ok" && run.stepKey === stepKey(w)) {
        try {
          if (!w.workdir || run.headSha !== (await this.o.git.headSha(w.workdir)))
            throw new Error("design commit changed before acceptance");
          if (!(await this.o.git.isClean(w.workdir)))
            throw new Error("design tree changed before acceptance");
          await this.verifiedDesign(project, w);
        } catch (error) {
          if (error instanceof DesignBindingChangedError) {
            await this.loopTo(project, w, "design", error.message);
            return "looped";
          }
          await this.transition(project, w, {
            ok: false,
            blocked: true,
            summary: (error as Error).message,
            receipts: [],
          });
          return "looped";
        }
        const receipts = await this.o.store.listReceipts(run.id);
        const { approved } = await this.approvalFor(w, "design", run.id, run.headSha!);
        const designApproved =
          !requiresApproval(autonomyFor(project, "design"), "design") || !!approved;
        await this.transition(project, w, {
          ok: true,
          summary: "verified design",
          receipts,
          designApproved,
        });
        return designApproved ? "replayed" : "approval";
      }
    }
    if (
      ["implement", "qa", "merge", "deploy"].includes(w.phase) &&
      (await this.designRequired(project, w))
    ) {
      try {
        await this.approvedDesign(project, w);
      } catch (error) {
        if (error instanceof DesignBindingChangedError) {
          await this.loopTo(project, w, "design", error.message);
          return "looped";
        }
        await this.transition(project, w, {
          ok: false,
          blocked: true,
          summary: (error as Error).message,
          receipts: [],
        });
        return "looped";
      }
    }
    const key = stepKey(w);
    const done = await this.o.store.getStep(key);
    if (done?.completedAt && done.output) {
      if (w.phase === "design") {
        const run = await this.latestRun(w, "design");
        const evidence = (done.output as PhaseOutcome).receipts
          .filter((receipt) => receipt.kind === "design")
          .map(designEvidence);
        if (
          !run ||
          run.status !== "ok" ||
          !w.workdir ||
          run.headSha !== (await this.o.git.headSha(w.workdir)) ||
          !evidence.length ||
          evidence.some(
            (item) =>
              !item ||
              item.runId !== run.id ||
              item.headSha !== run.headSha ||
              item.projectId !== w.projectId ||
              item.ticketId !== w.ticketId,
          )
        ) {
          await this.transition(project, w, {
            ok: false,
            blocked: true,
            summary: "stale or invalid design replay evidence",
            receipts: [],
          });
          return "looped";
        }
      }
      // Idempotency: this exact step already finished (crash before the transition was saved).
      await this.transition(project, w, done.output as PhaseOutcome);
      return "replayed";
    }

    // Checks start from a host-cleaned tree when the git port supports it: build artifacts and
    // untracked files are removed, modified tracked files send the ticket back to implement.
    let checkedSha: string | undefined;
    if (w.phase === "checks" && w.workdir && this.o.git.cleanForChecks) {
      try {
        checkedSha = await this.o.git.cleanForChecks(w.workdir);
      } catch (error) {
        await this.loopTo(
          project,
          w,
          "implement",
          `cannot clean for checks: ${(error as Error).message}`,
        );
        return "looped";
      }
    }

    // Validation and irreversible phases only ever see a committed, clean tree.
    if (CLEAN_TREE.has(w.phase) && w.workdir && !(await this.o.git.isClean(w.workdir))) {
      await this.loopTo(project, w, "implement", "uncommitted changes in the worktree");
      return "looped";
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

    if (this.o.projectDispatchAllowed?.(project.id) === false) return "conflict";
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

    const { model, provider, runner } = await this.phaseModel(project, w);
    // Checks bind to the SHA returned by cleanForChecks; review, QA, merge and deploy must match it.
    const headSha =
      checkedSha ??
      (CLEAN_TREE.has(w.phase) && w.workdir ? await this.o.git.headSha(w.workdir) : undefined);
    await this.o.store.createRun({
      id: runId,
      projectId: project.id,
      ticketId: w.ticketId,
      phase: w.phase,
      attempt: w.attempt,
      stepKey: key,
      runner,
      model,
      host: project.host,
      ownerId: this.ownerId,
      ...(headSha ? { headSha } : {}),
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
    const promise = this.execute(project, state, runId, key, controller, reserved, headSha).finally(
      () => this.active.delete(runId),
    );
    this.active.set(runId, {
      runId,
      projectId: project.id,
      ticketId: w.ticketId,
      phase: w.phase,
      model,
      provider,
      host: project.host,
      controller,
      promise,
    });
    // stop() ran while this dispatch was being set up: abort it like the runs it already swept.
    if (this.stopping) controller.abort(new ShutdownError("reconciler stopped"));
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
    validatedSha?: string,
  ): Promise<void> {
    const timer = setInterval(() => {
      void this.heartbeat(project.id, w.ticketId, runId, controller).catch(() => undefined);
    }, this.heartbeatMs);
    const timeoutMs = phaseTimeoutMs(project, w.phase);
    const runTimeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([controller.signal, runTimeout]);
    let lastTool: { at: Date; message: string } | undefined;
    // Only the phase wall clock firing counts: human stops, lease loss and shutdown keep their reason.
    const timedOutSummary = () =>
      runTimeout.aborted && signal.reason === runTimeout.reason
        ? runTimeoutSummary(timeoutMs, project.idleTimeoutMs, lastTool, this.clock())
        : undefined;
    const scratch: string[] = [];
    let outcome: PhaseOutcome;
    try {
      // Stopped (or taken over) between the claim and here: never launch the runner.
      if (!this.owns(await this.o.store.getWorkflow(project.id, w.ticketId), runId))
        throw new Error("run no longer owned at start");
      const tickets = this.o.tickets(project.id);
      const ticket = await tickets.get(w.ticketId);
      if (!ticket) throw new Error(`ticket ${w.ticketId} not found`);
      let ticketComments: TicketComment[] = [];
      if (tickets.listComments) {
        try {
          ticketComments = (await tickets.listComments(w.ticketId)).filter((c) => !c.byMatrix);
        } catch (error) {
          this.trackerFailed(project.id, w.ticketId, "comments", error);
        }
      }
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
        await this.trackerWrite(project.id, w.ticketId, "update", () =>
          tickets.update(w.ticketId, { status, phase: w.phase }),
        );
      const idempotencyKey = IRREVERSIBLE.has(w.phase)
        ? actionKey(w, await this.o.git.headSha(workdir))
        : key;
      const current = w;
      project = (await this.o.store.getProject(project.id)) ?? project;
      const designRequired = await this.designRequired(project, w);
      const evidence =
        designRequired && ["implement", "qa", "merge", "deploy"].includes(w.phase)
          ? await this.approvedDesign(project, w)
          : [];
      const ctx: PhaseContext = {
        classifyDesign: (paths) => this.designScope(project, current, paths),
        validateDesign: async () => {
          const fresh = (await this.o.store.getProject(project.id)) ?? project;
          if (await this.designRequired(fresh, current)) {
            const designs = await this.approvedDesign(fresh, current);
            ctx.project = fresh;
            ctx.designRequired = true;
            ctx.designEvidence = designs;
          }
        },
        ...(validatedSha ? { headSha: validatedSha } : {}),
        designRequired,
        designEvidence: evidence,
        project,
        workflow: current,
        ticket,
        ticketComments,
        tickets: bestEffortComments(tickets, (ticketId, operation, error) =>
          this.trackerFailed(project.id, ticketId, operation, error),
        ),
        runId,
        workdir,
        branch,
        idempotencyKey,
        signal,
        emit: (message, kind = "log", data) => {
          if (kind === "tool") lastTool = { at: this.clock(), message };
          void this.record(runId, kind, message, data);
        },
        scratchDir: async () => {
          await mkdir(this.scratchRoot, { recursive: true, mode: 0o700 });
          const dir = await mkdtemp(join(this.scratchRoot, `${runId}-`));
          scratch.push(dir);
          return dir;
        },
        stillOwner: async () =>
          this.owns(await this.o.store.getWorkflow(project.id, current.ticketId), runId),
        authorize: async (phase) => {
          const latest = await this.o.store.getWorkflow(project.id, current.ticketId);
          if (!this.owns(latest, runId)) return { ok: false, reason: "lease lost", kind: "gates" };
          return this.authorize(project, latest, phase);
        },
      };
      outcome = await this.o.handlers[w.phase](ctx);
      outcome = await this.enforceTree(w.phase, workdir, outcome, validatedSha);
      if (outcome.ok && project.agents?.designFirst && w.phase === "implement") {
        const scope = await this.designScope(project, w);
        if (!scope.changesVerified)
          outcome = {
            ...outcome,
            ok: false,
            blocked: true,
            summary:
              "host implementation change inspection is missing; design policy cannot be waived",
          };
        else if (
          (scope.required && !designRequired) ||
          scope.uiChangedPaths.some((path) => !scope.paths.includes(path))
        )
          outcome = {
            ...outcome,
            ok: false,
            restartDesign: true,
            summary: "actual UI changes exceed the spike/design scope; new design required",
          };
      }
      if (outcome.ok && ["implement", "qa"].includes(w.phase)) await ctx.validateDesign?.();
      if (signal.aborted) {
        outcome = {
          ok: false,
          summary:
            timedOutSummary() ?? String((signal.reason as Error | undefined)?.message ?? "aborted"),
          receipts: outcome.receipts,
          runStatus: signal.reason instanceof HumanStopError ? "cancelled" : "timeout",
        };
      }
    } catch (error) {
      outcome = {
        ok: false,
        summary: timedOutSummary() ?? (error as Error).message,
        receipts: [],
        ...(error instanceof DesignBindingChangedError
          ? { restartDesign: true }
          : { runStatus: signal.aborted ? ("timeout" as const) : ("failed" as const) }),
      };
      if (signal.reason instanceof HumanStopError)
        outcome = { ...outcome, summary: signal.reason.message, runStatus: "cancelled" };
    } finally {
      clearInterval(timer);
      await Promise.all(
        scratch.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)),
      );
    }

    // Fencing: only the lease holder of this exact run may record a step result or move the workflow.
    const latest = await this.o.store.getWorkflow(project.id, w.ticketId);
    const latestWorkdir = latest?.workdir;
    // Stopped by a human (here or through another reconciler): record why, not the lease loss.
    const humanStop =
      latest?.status === "blocked" && latest.stoppedBy === "human"
        ? (latest.lastError ?? HUMAN_STOP)
        : undefined;
    const fenced = !this.owns(latest, runId);
    if (fenced && humanStop)
      outcome = { ...outcome, ok: false, summary: humanStop, runStatus: "cancelled" };
    if (fenced && w.workdir && w.workspaceRef && latestWorkdir !== w.workdir) {
      // Another reconciler took over on a fresh worktree; this one is ours to dispose of.
      await this.o.workspace
        .cleanup({ workdir: w.workdir, ref: w.workspaceRef })
        .catch(() => undefined);
    }
    // Shutdown (a deploy restarting the server) is never the ticket's failure: re-queue it as is.
    const interrupted =
      !fenced && !humanStop && signal.reason instanceof ShutdownError && !runTimeout.aborted;
    if (interrupted)
      outcome = { ...outcome, ok: false, summary: INTERRUPTED_SUMMARY, runStatus: "cancelled" };
    const quota =
      fenced || interrupted
        ? undefined
        : await this.quotaOutcome(project.id, w.ticketId, runId, outcome);
    // A quota failure is never a completed step (so it re-runs, not replays) nor an attempt.
    if (quota)
      outcome = {
        ...outcome,
        ok: false,
        runStatus: "failed",
        summary: `${isGatewayUnavailable(quota.reason) ? "gateway" : "quota"}: ${outcome.summary}`,
      };
    await this.finish(project, runId, key, outcome, reserved, fenced, humanStop !== undefined);
    if (fenced) return;
    if (interrupted) await this.requeueInterrupted(latest as WorkflowState);
    else if (quota) await this.deferForQuota(project, latest as WorkflowState, quota);
    else await this.transition(project, latest as WorkflowState, outcome);
  }

  /**
   * Classifies a finished run for the quota guard. A runner failure whose output reads like a
   * rate/usage limit puts the provider into cooldown and defers the ticket (up to a cap per
   * workflow, so a ticket that merely talks about rate limits cannot loop forever).
   */
  private async quotaOutcome(
    projectId: string,
    ticketId: string,
    runId: string,
    outcome: PhaseOutcome,
  ): Promise<ProviderCooldown | undefined> {
    if (!this.cooldowns) return undefined;
    // The provider the dispatch was gated on, so the cooldown gates the same name.
    const provider = this.active.get(runId)?.provider;
    if (!provider) return undefined;
    const key = `${projectId}\u0000${ticketId}`;
    if (outcome.ok) {
      this.cooldowns.clear(provider);
      this.quotaDeferrals.delete(key);
      return undefined;
    }
    if (outcome.runStatus !== "failed") return undefined;
    // Runner-level errors and the summary tail (where the CLI's stderr lands) only: failed tool
    // calls carry arbitrary content (a curl to an API returning 429 is not our quota).
    const errors = (await this.o.store.listEvents(runId))
      .filter((event) => event.kind === "error" && !event.message.startsWith("tool error:"))
      .map((event) => event.message.slice(-500));
    const text = [...errors, outcome.summary.slice(-500)].join("\n");
    // A gateway that could not confirm the model is infrastructure, deferred like a quota hit.
    const gateway = isGatewayUnavailable(text);
    if (!gateway && !isQuotaError(text)) return undefined;
    // Past the cap (until a success or a human re-queue) failures count as attempts again and no
    // longer touch the shared cooldown: one poisoned ticket cannot stall the provider.
    const deferrals = (this.quotaDeferrals.get(key) ?? 0) + 1;
    this.quotaDeferrals.set(key, deferrals);
    if (deferrals > MAX_QUOTA_DEFERRALS) return undefined;
    const line =
      text.split("\n").find((l) => (gateway ? isGatewayUnavailable(l) : isQuotaError(l))) ??
      (gateway ? "gateway unavailable" : "rate limited");
    const cooldown = this.cooldowns.hit(provider, line.trim().slice(0, 200), this.clock());
    this.o.bus.publish({
      type: "quota.cooldown",
      ...publicCooldown(cooldown),
      provider,
      projectId,
      ticketId,
    });
    return cooldown;
  }

  /** Puts a run interrupted by shutdown back in the queue now: same phase, attempt unchanged. */
  private async requeueInterrupted(w: WorkflowState): Promise<void> {
    const next: WorkflowState = { ...w, status: "pending", lastError: INTERRUPTED_SUMMARY };
    delete next.leaseOwner;
    delete next.leaseExpiresAt;
    delete next.nextAttemptAt;
    try {
      const saved = await this.o.store.saveWorkflow(next);
      this.o.bus.publish({ type: "workflow.changed", workflow: saved });
    } catch (error) {
      // Someone else moved the workflow meanwhile (cancel, takeover): their state wins.
      if (!(error instanceof VersionConflictError)) throw error;
    }
  }

  /** Puts the workflow back in the queue until the provider's cooldown ends; attempt unchanged. */
  private async deferForQuota(
    project: ProjectConfig,
    w: WorkflowState,
    cooldown: ProviderCooldown,
  ): Promise<void> {
    const next: WorkflowState = {
      ...w,
      status: "pending",
      nextAttemptAt: cooldown.until,
      lastError: isGatewayUnavailable(cooldown.reason)
        ? `waiting for the model gateway: ${cooldown.reason}`
        : `waiting for ${cooldown.provider} quota: ${cooldown.reason}`,
    };
    delete next.leaseOwner;
    delete next.leaseExpiresAt;
    try {
      const saved = await this.o.store.saveWorkflow(next);
      this.o.bus.publish({ type: "workflow.changed", workflow: saved });
    } catch (error) {
      // Someone else moved the workflow meanwhile (cancel, takeover): their state wins.
      if (!(error instanceof VersionConflictError)) throw error;
    }
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
    humanStop = false,
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
      summary: fenced && !humanStop ? `fenced (lease lost): ${outcome.summary}` : outcome.summary,
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
    // Neither are "ask again" outcomes (merge not authorized or not merged yet): after the next
    // approval the action must run again, not replay its earlier refusal.
    if (
      !fenced &&
      (!outcome.runStatus || outcome.runStatus === "ok") &&
      !outcome.requiresApproval
    ) {
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
      receipts: outcome.receipts.map(publicQaReceipt),
    });
  }

  private async transition(
    project: ProjectConfig,
    w: WorkflowState,
    outcome: PhaseOutcome,
  ): Promise<void> {
    project = (await this.o.store.getProject(project.id)) ?? project;
    if (w.phase === "spike" && outcome.ok)
      outcome = {
        ...outcome,
        targetsUi: outcome.targetsUi || (await this.designRequired(project, w)),
      };
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
    // The merge itself is reported on the ticket (PR link and merge commit), not only the status.
    if (w.phase === "merge" && outcome.ok && outcome.summary)
      await this.trackerWrite(project.id, w.ticketId, "comment", () =>
        this.o
          .tickets(project.id)
          .comment(w.ticketId, `Matrix merged this ticket: ${outcome.summary}`),
      );
  }

  /**
   * Tracker writes are best effort: a down tracker must never fail the workflow, but the failure
   * is published (`tracker.failed`) instead of being swallowed.
   */
  private async trackerWrite(
    projectId: string,
    ticketId: string,
    operation: string,
    write: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.trackerFailed(projectId, ticketId, operation, error);
    }
  }

  private trackerFailed(projectId: string, ticketId: string, operation: string, error: unknown) {
    this.o.bus.publish({
      type: "tracker.failed",
      projectId,
      ticketId,
      operation,
      message: error instanceof Error ? error.message : String(error),
      at: this.clock().toISOString(),
    });
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
        // Label first: on Linear its absence is a re-queue signal for tickets blocked in Ready.
        if (tickets.addLabel)
          await this.trackerWrite(project.id, saved.ticketId, "addLabel", async () =>
            tickets.addLabel?.(saved.ticketId, NEEDS_HUMAN_LABEL),
          );
        await this.trackerWrite(project.id, saved.ticketId, "update", () =>
          tickets.update(saved.ticketId, { status: "blocked" }),
        );
        await this.trackerWrite(project.id, saved.ticketId, "comment", () =>
          tickets.comment(
            saved.ticketId,
            [
              `Matrix blocked this ticket: ${effect.reason}`,
              `It needs a human. Fix the cause (ticket, config or quota), then move the ticket back to Ready to restart it; Matrix then removes the \`${NEEDS_HUMAN_LABEL}\` label. At most ${this.maxRequeues} restarts per day.`,
            ].join("\n\n"),
          ),
        );
        this.o.bus.publish({
          type: "workflow.blocked",
          projectId: project.id,
          ticketId: saved.ticketId,
          reason: effect.reason,
        });
      } else if (effect.type === "done") {
        this.quotaDeferrals.delete(`${project.id}\u0000${saved.ticketId}`);
        await this.trackerWrite(project.id, saved.ticketId, "update", () =>
          tickets.update(saved.ticketId, { status: "done" }),
        );
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
      // Never reuse a worktree a possibly-alive old runner may still write to.
      const fresh: WorkflowState = { ...w };
      delete fresh.workdir;
      delete fresh.workspaceRef;
      try {
        await this.transition(project, fresh, {
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

  /**
   * `actor` must come from the authenticated session or key (never a bare identity string).
   * Approving a merge or deploy requires a human actor that is not the requester, not a
   * reconciler and not the owner of the approved run.
   */
  async decideApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    actor: Actor,
    note?: string,
  ): Promise<WorkflowState> {
    assertActor(actor);
    const decider = actor;
    const by = decider.id;
    const approval = await this.o.store.getApproval(approvalId);
    if (!approval) throw new Error(`approval ${approvalId} not found`);
    if (decision === "approved" && decider.kind !== "human") {
      throw new Error(
        `${approval.phase} approvals require a human approver, got ${decider.kind} ${by}`,
      );
    }
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
      if (approval.status !== "pending") throw new Error("approval has already been decided");
      const candidate = await this.candidateRun(w, approval.phase);
      if (
        candidate?.id !== approval.runId ||
        (approval.phase === "design" && candidate.headSha !== approval.headSha)
      )
        throw new Error("approval does not cover the current phase run/SHA");
      if (approval.phase === "design") {
        if (!w.workdir || !(await this.o.git.isClean(w.workdir)))
          throw new Error("design tree changed since the approval request");
        const receipts = await this.o.store.listReceipts(run.id);
        const project = await this.o.store.getProject(approval.projectId);
        if (project) await this.verifiedDesign(project, w);
        if (
          !project ||
          !gate("design", { ok: true, summary: "", receipts }, project).pass ||
          receipts
            .filter((receipt) => receipt.kind === "design")
            .some((receipt) => {
              const evidence = designEvidence(receipt);
              return (
                !evidence ||
                evidence.runId !== run.id ||
                evidence.headSha !== approval.headSha ||
                evidence.projectId !== approval.projectId ||
                evidence.ticketId !== approval.ticketId
              );
            })
        )
          throw new Error("invalid design approval evidence");
      }
      if (w.workdir && (await this.o.git.headSha(w.workdir)) !== approval.headSha) {
        throw new Error("HEAD moved since the approval was requested; request a new approval");
      }
    }
    const decided = await this.o.store.decideApproval(approvalId, decision, decider, note);
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

  /**
   * Handover is checked without cleaning: anything uncommitted (tracked or untracked) is agent work
   * that must be committed, never silently deleted. cleanForChecks only runs later, before checks.
   */
  private async handedOverClean(workdir: string): Promise<boolean> {
    return this.o.git.isClean(workdir);
  }

  /**
   * Implement must hand over a committed tree. A validation run must leave HEAD and the tree
   * exactly as it found them, so its verdict applies to the commit it recorded.
   */
  private async enforceTree(
    phase: Phase,
    workdir: string,
    outcome: PhaseOutcome,
    validatedSha?: string,
  ): Promise<PhaseOutcome> {
    if (outcome.runStatus && outcome.runStatus !== "ok") return outcome;
    if (phase === "implement" && outcome.ok && !(await this.handedOverClean(workdir))) {
      return {
        ...outcome,
        ok: false,
        summary:
          "implement left uncommitted or untracked files; commit your work (or ignore build output) before handing over",
      };
    }
    if (VALIDATING.has(phase) && validatedSha) {
      const head = await this.o.git.headSha(workdir);
      const clean = await this.o.git.isClean(workdir);
      if (head !== validatedSha || !clean) {
        return {
          ...outcome,
          ok: false,
          runStatus: "failed",
          summary: `${phase} changed the tree (validated ${validatedSha.slice(0, 12)}, now ${head.slice(0, 12)}${clean ? "" : " + uncommitted"})`,
        };
      }
    }
    return outcome;
  }
}

type AgentQaLabelFix = LabelRetry;

/** Why a posted agent QA verdict is redone; `device: false` re-checks only the GitHub criteria. */
interface AgentQaRerun {
  device: boolean;
  reason: string;
  /** Requested with the `qa:rerun` label (removed when the run starts). */
  label?: boolean;
}

/**
 * Surfaces a lane run covers: the QA run's snapshot, plus any surface the project config enables
 * NOW that routing selects for this ticket and diff (e.g. iOS turned on after the first run, then a
 * rerun). Never fewer than the snapshot: a partial GitHub file list only ever adds.
 */
export function laneRunSurfaces(
  project: ProjectConfig,
  ticket: { body: string; labels?: readonly string[] },
  snapshot: readonly QaSurface[],
  facts: PullRequestFacts | undefined,
): QaSurface[] {
  const out = new Set<QaSurface>(snapshot);
  if (facts?.files.length)
    for (const s of requiredDeviceSurfaces(
      project,
      ticket,
      facts.files.map((f) => f.path),
    ))
      out.add(s);
  return [...out];
}

/** The ticket's acceptance criteria as they are now; the QA run's snapshot when it lists none. */
function qaCriteria(body: string, snapshot: string[]): string[] {
  const now = acceptanceCriteria(body);
  return now.length ? now : snapshot;
}

/** Label-write retry backoff: doubles from the base, capped (an hour for permission failures). */
const LABEL_RETRY_BASE_MS = 30_000;
const LABEL_RETRY_CAP_MS = 10 * 60_000;
const LABEL_RETRY_PERMANENT_CAP_MS = HOUR_MS;

/** The tracker refused the actor the right (e.g. to create a label): only a human can fix it. */
function isPermissionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as Error & { code?: unknown; status?: unknown };
  // Code/status first; the message test only matches Linear's own wording, never a network error.
  return (
    e.code === "FORBIDDEN" || e.status === 403 || /\byou are not allowed to\b/i.test(e.message)
  );
}
