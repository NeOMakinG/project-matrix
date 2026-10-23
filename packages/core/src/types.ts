import type { DesignInput } from "./design.js";
import type { AutonomyMode, Phase, Receipt, RunnerId, RunStatus } from "./ports.js";

export type WorkflowStatus = "pending" | "running" | "waiting_approval" | "blocked" | "done";

export interface WorkflowState {
  projectId: string;
  ticketId: string;
  phase: Phase;
  status: WorkflowStatus;
  attempt: number;
  loops: number;
  priority: number;
  implementerModel?: string;
  workspaceRef?: string;
  workdir?: string;
  currentRunId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  /** Hash of the worktree state that review approved; checks re-run if it changes. */
  reviewedTree?: string;
  lastError?: string;
  nextAttemptAt?: Date;
  /** Bumped each time a human re-queues a blocked ticket; part of the step key. */
  generation?: number;
  /** When a human last re-queued this ticket (per-ticket budgets count from here). */
  requeuedAt?: Date;
  /** Re-queues during the UTC day of `requeuedAt` (flapping guard). */
  requeueCount?: number;
  /** Set only by `Reconciler.stopWorkflow`: a human stopped it, so resuming costs no budget. */
  stoppedBy?: "human";
  version: number;
}

export interface PhaseModel {
  runner: RunnerId;
  model: string;
}

export const REVIEW_LANES = [
  "correctness-security",
  "architecture-adr",
  "ux-product",
  "performance",
] as const;
export type ReviewLane = (typeof REVIEW_LANES)[number];

/** How a check's output is turned into failure identities for the base comparison. */
export type CheckParser = "eslint-json" | "tsc" | "node-test-tap" | "vitest-json" | "exit-code";
/** `compare`: only failures absent on the base commit fail the check. `strict`: any failure. */
export type BaselineMode = "compare" | "strict";

export interface CheckCommand {
  kind: "typecheck" | "lint" | "test" | "adr-check";
  cmd: string[];
  /** Unset: detected from the argv (eslint, vitest, tsc, node --test), else exit-code. */
  parser?: CheckParser;
  /** Unset: the baseline port's default (compare for existing repos, strict otherwise). */
  baseline?: BaselineMode;
}

export interface ProjectConfig {
  agents?: { designFirst?: boolean; figmaMcp?: boolean };
  design?: DesignInput;
  id: string;
  name: string;
  repoPath: string;
  baseBranch: string;
  host: string;
  models: Partial<Record<Phase, PhaseModel | undefined>> & {
    review: PhaseModel;
    implement: PhaseModel;
    tiers?: { large: PhaseModel; small: PhaseModel } | undefined;
    smallEstimateThreshold?: number;
    aliases?: Record<string, string>;
  };
  reviewerFallbacks: PhaseModel[];
  autonomy: { default: AutonomyMode } & Partial<Record<Phase, AutonomyMode>>;
  reviewLanes: ReviewLane[];
  checks: CheckCommand[];
  holdoutThreshold: number;
  maxLoops: number;
  maxAttempts: number;
  runTimeoutMs: number;
  /** Per-phase overrides of `runTimeoutMs` (ms); phases left out use `runTimeoutMs`. */
  timeouts?: Partial<Record<Phase, number>>;
  /** Model runs with no output for this long stop as "runner idle" (ms). Unset: runner default. */
  idleTimeoutMs?: number;
  /** Operator-written implement guidance (trusted project config), appended to the prompt. */
  implementGuidance?: string;
  /**
   * Last phase of the loop; the workflow is done once it passes. Existing-repo projects end at
   * `merge` (the human merges the draft PR on GitHub); unset runs every phase.
   */
  lastPhase?: Phase;
  dailyBudgetUsd?: number;
  /** Reserved against the daily budget before dispatch, settled with the actual cost after. */
  estimatedRunUsd?: number;
  /** Spend cap per ticket (since its last re-queue); only enforced when runs report spend. */
  perTicketBudgetUsd?: number;
}

export type Severity = "P1" | "P2" | "P3";

export interface ReviewFinding {
  severity: Severity;
  title: string;
  file?: string;
  detail?: string;
}

export interface PhaseOutcome {
  restartDesign?: boolean;
  targetsUi?: boolean;
  designApproved?: boolean;
  blocked?: boolean;
  ok: boolean;
  summary: string;
  receipts: Receipt[];
  runStatus?: RunStatus;
  model?: string;
  runner?: RunnerId;
  tokens?: { input: number; output: number };
  costUsd?: number;
  /** Set when an irreversible action was refused because it now needs (re)approval. */
  requiresApproval?: boolean;
  /**
   * `factory-tooling`: Matrix itself is broken. `environment`: the run environment cannot execute
   * the checks (missing dependencies or binaries); both block for a human, neither consumes
   * implement attempts.
   */
  failureClass?: "factory-tooling" | "environment";
}

export interface Limits {
  perProject: number;
  perModel: Record<string, number>;
  defaultPerModel: number;
  perHost: Record<string, number>;
  defaultPerHost: number;
}

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}
