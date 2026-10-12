import type { Ticket, TicketStore } from "@matrix/tickets";
import type { AutonomyMode, Receipt, RunEventKind } from "./ports.js";
import type { ProjectConfig, WorkflowState } from "./types.js";

export interface PhaseContext {
  project: ProjectConfig;
  workflow: WorkflowState;
  ticket: Ticket;
  tickets: TicketStore;
  runId: string;
  workdir: string;
  branch: string;
  signal: AbortSignal;
  emit(message: string, kind?: RunEventKind, data?: unknown): void;
}

export interface QaDriver {
  run(ctx: PhaseContext): Promise<Receipt[]>;
}

export interface MergePort {
  merge(
    ctx: PhaseContext,
    mode: AutonomyMode,
  ): Promise<{ ok: boolean; summary: string; url?: string }>;
}

export interface DeployPort {
  deploy(ctx: PhaseContext): Promise<{ ok: boolean; summary: string; url?: string }>;
}

export interface VerifyPort {
  verify(ctx: PhaseContext): Promise<Receipt[]>;
}
