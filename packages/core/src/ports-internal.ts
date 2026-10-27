import type { Ticket, TicketComment, TicketStore } from "@matrix/tickets";
import type { DesignEvidence, DesignScope } from "./design.js";
import type { HoldoutScenario } from "./holdout.js";
import type { AutonomyMode, Phase, Receipt, RunEventKind } from "./ports.js";
import type { PullRequestFacts } from "./qa-criteria.js";
import type { JudgeScenarioEvidence } from "./qa-evidence.js";
import type { PhaseModel, ProjectConfig, QaSurface, WorkflowState } from "./types.js";

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
  /**
   * Optional (feature-detected): moves the clean run branch onto `onto` (a commit already in the
   * repository). A clean rebase keeps the commits; a conflicting one re-applies the branch's
   * squashed change on `onto` and leaves the conflict markers uncommitted for the implementer.
   */
  syncOnto?(workdir: string, onto: string): Promise<BaseSyncResult>;
  /**
   * Optional (feature-detected): points the clean run branch at `headSha` (a commit pushed to the
   * PR outside Matrix, already fetched) and moves the trusted BASE to `forkSha`.
   */
  adoptHead?(workdir: string, headSha: string, forkSha: string): Promise<void>;
}

export interface QaDriver {
  /** Surfaces this driver can exercise on this host; unset = host/api/web probes only. */
  readonly surfaces?: readonly QaSurface[];
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
  /** Set when QA was handed off to a human: surfaces + PUBLIC acceptance criteria (never holdout text). */
  manualQa?: { surfaces: QaSurface[]; criteria: string[] };
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
  /** Optional: add/remove labels on a published PR (labels created when missing). */
  label?(project: ProjectConfig, url: string, add: string[], remove: string[]): Promise<void>;
  /** Optional: what GitHub says about a published PR now (body, changed files, head checks). */
  facts?(project: ProjectConfig, url: string): Promise<PullRequestFacts>;
  /**
   * Optional: whether the published PR of `headSha` can merge into its base as is. `outdated`
   * (conflicts, or behind a base that must be up to date) fetches the base tip host-side and
   * returns its SHA so the run branch can be rebased onto it before the auto-merge.
   */
  baseState?(project: ProjectConfig, ticketId: string, headSha: string): Promise<BaseState>;
  /**
   * Optional: the head of the ticket's open PR when someone pushed to it outside Matrix (it differs
   * from the head Matrix last published). The commit is fetched host-side; `forkSha` is its
   * merge-base with the fetched base tip. Undefined when the PR head is Matrix's own.
   */
  externalHead?(
    project: ProjectConfig,
    ticketId: string,
  ): Promise<{ headSha: string; forkSha: string } | undefined>;
}

export type BaseState =
  | { kind: "current" }
  | { kind: "wait"; reason: string }
  | { kind: "outdated"; reason: string; base: string; baseSha: string };

/** Outcome of moving a run branch onto a newer base tip (host-side, never pushes). */
export type BaseSyncResult =
  | { kind: "current" }
  | { kind: "rebased"; headSha: string }
  /** The ticket's change is re-applied on the base with conflict markers left uncommitted. */
  | { kind: "conflict"; files: string[] };

export interface DeployPort {
  deploy(
    ctx: PhaseContext,
    request: ActionRequest,
  ): Promise<{
    ok: boolean;
    summary: string;
    url?: string;
    /** A human must act (held migration, missing capability, coordination): never retried. */
    blocked?: boolean;
    receipts?: Receipt[];
  }>;
}

export interface VerifyPort {
  verify(ctx: PhaseContext): Promise<Receipt[] | { receipts: Receipt[]; blocked?: string }>;
}
