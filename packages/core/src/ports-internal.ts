import type { Ticket, TicketComment, TicketStore } from "@matrix/tickets";
import type { DesignEvidence, DesignScope } from "./design.js";
import type { HoldoutScenario } from "./holdout.js";
import type { AutonomyMode, Phase, Receipt, RunEventKind } from "./ports.js";
import type { JudgeScenarioEvidence } from "./qa-evidence.js";
import type { PhaseModel, ProjectConfig, WorkflowState } from "./types.js";

export type Authorization =
  | { ok: true; headSha: string; mode: AutonomyMode; approvalId?: string }
  /** `approval`: ask (again) for an approval; `gates`: earlier evidence no longer holds, never act. */
  | { ok: false; reason: string; kind: "approval" | "gates" };

export interface PhaseContext {
  classifyDesign?: (plannedPaths: string[]) => Promise<DesignScope>;
  validateDesign?: () => Promise<void>;
  headSha?: string;
  designRequired?: boolean;
  designEvidence?: DesignEvidence[];
  project: ProjectConfig;
  workflow: WorkflowState;
  ticket: Ticket;
  /** Human comments on the ticket (Matrix's own excluded), sanitized; empty when unsupported. */
  ticketComments?: TicketComment[];
  tickets: TicketStore;
  runId: string;
  workdir: string;
  branch: string;
  /** Stable per step; merge and deploy adapters must dedupe on it. */
  idempotencyKey: string;
  signal: AbortSignal;
  emit(message: string, kind?: RunEventKind, data?: unknown): void;
  /** A fresh empty directory outside the worktree, for models that must not see or touch the code. */
  scratchDir(): Promise<string>;
  /**
   * Re-checks autonomy, approval binding and gate receipts immediately before an
   * irreversible action. Merge and deploy handlers must call it right before acting.
   */
  authorize(phase: Extract<Phase, "merge" | "deploy">): Promise<Authorization>;
  /** True while this run still holds the workflow lease; checked right before irreversible calls. */
  stillOwner(): Promise<boolean>;
}

export interface GitPort {
  headSha(workdir: string): Promise<string>;
  /** Hash of HEAD plus uncommitted changes; differs whenever the tree changed. */
  treeState(workdir: string): Promise<string>;
  /** True when there are no uncommitted or untracked changes. */
  isClean(workdir: string): Promise<boolean>;
  /**
   * Optional (feature-detected): removes untracked and ignored files host-side, refuses modified
   * tracked files, and returns the exact HEAD SHA the checks will run against.
   */
  cleanForChecks?(workdir: string): Promise<string>;
}

export interface QaDriver {
  run(
    ctx: PhaseContext,
    request?: { scenarios: HoldoutScenario[]; reviewer: PhaseModel },
  ): Promise<
    Receipt[] | { receipts: Receipt[]; costUsd?: number; judgeEvidence?: JudgeScenarioEvidence[] }
  >;
}

export interface ActionRequest {
  headSha: string;
  idempotencyKey: string;
  mode: AutonomyMode;
}

export interface MergePort {
  merge(
    ctx: PhaseContext,
    request: ActionRequest,
  ): Promise<{
    ok: boolean;
    summary: string;
    url?: string;
    mergedSha?: string;
    /** Nothing failed, the merge just has not happened yet: the workflow waits for approval again. */
    pending?: boolean;
  }>;
}

/** Evidence of one earlier phase, quoted in the pull request body. */
export interface PullRequestEvidence {
  phase: Phase;
  summary: string;
  /** https links from that phase's receipts. */
  urls: string[];
}

export interface PullRequestRequest {
  project: ProjectConfig;
  workflow: WorkflowState;
  ticket: Ticket;
  /** The commit checks, review and QA validated; exactly this SHA is pushed. */
  headSha: string;
  evidence: PullRequestEvidence[];
}

/**
 * Host-side publication of a validated run: pushes the run branch and opens (or reuses) a DRAFT
 * pull request. Never merges, never pushes the base branch, never force-pushes. Returns undefined
 * for projects it does not publish (e.g. greenfield projects merged locally).
 */
export interface PullRequestPort {
  /** Cheap pre-check: false for projects this port never publishes (skips all work). */
  handles?(project: ProjectConfig): boolean;
  publish(request: PullRequestRequest): Promise<{ url: string; branch: string } | undefined>;
}

export interface DeployPort {
  deploy(
    ctx: PhaseContext,
    request: ActionRequest,
  ): Promise<{ ok: boolean; summary: string; url?: string }>;
}

export interface VerifyPort {
  verify(ctx: PhaseContext): Promise<Receipt[]>;
}
