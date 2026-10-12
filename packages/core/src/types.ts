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
  lastError?: string;
  nextAttemptAt?: Date;
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

export interface CheckCommand {
  kind: "typecheck" | "lint" | "test" | "adr-check";
  cmd: string[];
}

export interface ProjectConfig {
  id: string;
  name: string;
  repoPath: string;
  baseBranch: string;
  host: string;
  models: Partial<Record<Phase, PhaseModel>> & { review: PhaseModel; implement: PhaseModel };
  reviewerFallbacks: PhaseModel[];
  autonomy: { default: AutonomyMode } & Partial<Record<Phase, AutonomyMode>>;
  reviewLanes: ReviewLane[];
  checks: CheckCommand[];
  holdoutThreshold: number;
  maxLoops: number;
  maxAttempts: number;
  runTimeoutMs: number;
  dailyBudgetUsd?: number;
}

export type Severity = "P1" | "P2" | "P3";

export interface ReviewFinding {
  severity: Severity;
  title: string;
  file?: string;
  detail?: string;
}

export interface PhaseOutcome {
  ok: boolean;
  summary: string;
  receipts: Receipt[];
  runStatus?: RunStatus;
  model?: string;
  runner?: RunnerId;
  tokens?: { input: number; output: number };
  costUsd?: number;
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
