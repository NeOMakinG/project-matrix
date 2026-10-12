import {
  type ApprovalRecord,
  type AutonomyMode,
  autonomyFor,
  PHASES,
  type Phase,
  type ProjectConfig,
  REVIEW_LANES,
  type RunRecord,
} from "@matrix/core";
import type { Approval, Project, Run } from "../core-port.js";
import type { TicketSettings } from "./tickets.js";

/** Server-side metadata kept inside the stored project config (core stores the config as JSON). */
export interface MatrixMeta {
  description: string;
  workspace: "orca" | "native";
  tickets: TicketSettings;
  createdAt: string;
}

export type StoredProject = ProjectConfig & { matrix?: MatrixMeta };

export const iso = (d: Date | string | undefined) =>
  d === undefined ? undefined : d instanceof Date ? d.toISOString() : d;

export function toProject(config: StoredProject): Project {
  const autonomy = {} as Record<Phase, AutonomyMode>;
  for (const phase of PHASES) autonomy[phase] = autonomyFor(config, phase);
  return {
    id: config.id,
    name: config.name,
    description: config.matrix?.description ?? "",
    workspace: config.matrix?.workspace ?? "native",
    autonomy,
    createdAt: config.matrix?.createdAt ?? new Date(0).toISOString(),
  };
}

const RUN_STATE: Record<RunRecord["status"], Run["state"]> = {
  running: "running",
  ok: "ok",
  failed: "failed",
  timeout: "timeout",
  cancelled: "cancelled",
  stalled: "failed",
};

export function toRun(
  record: RunRecord,
  extra: { title?: string; awaitingApproval?: boolean } = {},
): Run {
  return {
    id: record.id,
    projectId: record.projectId,
    ticketId: record.ticketId,
    ownerId: record.ownerId,
    phase: record.phase,
    state: extra.awaitingApproval ? "awaiting_approval" : RUN_STATE[record.status],
    runner: record.runner ?? "unknown",
    model: record.model ?? "unknown",
    startedAt: record.startedAt.toISOString(),
    updatedAt: (record.finishedAt ?? record.lastEventAt).toISOString(),
    costUsd: record.costUsd ?? 0,
    ...(record.headSha ? { headSha: record.headSha } : {}),
    ...(extra.title ? { title: extra.title } : {}),
  };
}

export function toApproval(record: ApprovalRecord): Approval {
  return {
    id: record.id,
    projectId: record.projectId,
    ticketId: record.ticketId,
    phase: record.phase,
    runId: record.runId,
    headSha: record.headSha,
    requestedBy: record.requestedBy,
    status: record.status,
    requestedAt: record.requestedAt.toISOString(),
    ...(record.decidedAt ? { decidedAt: record.decidedAt.toISOString() } : {}),
    ...(record.decidedBy ? { decidedBy: record.decidedBy } : {}),
    ...(record.decidedByKind ? { decidedByKind: record.decidedByKind } : {}),
    ...(record.note ? { note: record.note } : {}),
  };
}

/** Defaults for a new project; the init interview later rewrites models, checks and lanes. */
export function newProjectConfig(input: {
  id: string;
  name: string;
  repoPath: string;
  host: string;
  meta: MatrixMeta;
}): StoredProject {
  return {
    id: input.id,
    name: input.name,
    repoPath: input.repoPath,
    baseBranch: "main",
    host: input.host,
    models: {
      implement: { runner: "claude-code", model: "claude-fable-5-1" },
      review: { runner: "codex", model: "gpt-6.1-sol" },
    },
    reviewerFallbacks: [],
    autonomy: { default: "human" },
    reviewLanes: [...REVIEW_LANES],
    checks: [
      { kind: "typecheck", cmd: ["bun", "run", "typecheck"] },
      { kind: "lint", cmd: ["bun", "run", "lint"] },
      { kind: "test", cmd: ["bun", "run", "test"] },
    ],
    holdoutThreshold: 0.8,
    maxLoops: 3,
    maxAttempts: 3,
    runTimeoutMs: 30 * 60 * 1000,
    matrix: input.meta,
  };
}
