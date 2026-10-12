import type { Ticket, TicketStore } from "@matrix/tickets";
import type { AutonomyMode, Phase, Receipt, RunEventKind } from "./ports.js";
import type { ProjectConfig, WorkflowState } from "./types.js";

export type Authorization =
  | { ok: true; headSha: string; mode: AutonomyMode; approvalId?: string }
  /** `approval`: ask (again) for an approval; `gates`: earlier evidence no longer holds, never act. */
  | { ok: false; reason: string; kind: "approval" | "gates" };

export interface PhaseContext {
  project: ProjectConfig;
  workflow: WorkflowState;
  ticket: Ticket;
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
}

export interface QaDriver {
  run(ctx: PhaseContext): Promise<Receipt[]>;
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
  ): Promise<{ ok: boolean; summary: string; url?: string; mergedSha?: string }>;
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
