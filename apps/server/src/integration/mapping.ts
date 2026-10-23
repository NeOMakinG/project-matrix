import { recommendedModels } from "@matrix/config";
import {
  type ApprovalRecord,
  type AutonomyMode,
  autonomyFor,
  PHASES,
  type Phase,
  type ProjectConfig,
  phaseTimeoutMs,
  REVIEW_LANES,
  type RunRecord,
} from "@matrix/core";
import {
  type Approval,
  CoreError,
  type PhaseTimeoutsInput,
  type Project,
  type Run,
  type SetupStep,
  type UpdateProjectInput,
} from "../core-port.js";
import type { TicketSettings } from "./tickets.js";

/** Server-side metadata kept inside the stored project config (core stores the config as JSON). */
export interface MatrixMeta {
  description: string;
  workspace: "orca" | "native";
  tickets: TicketSettings;
  createdAt: string;
  /**
   * Set for a repo that already existed on the host (registered, not created by Matrix). Its
   * config lives here, host-side; nothing is written into the repo and runs end with a draft PR.
   */
  repo?: {
    external: true;
    remote: string;
    github: string;
    editablePaths?: string[];
    /** Dependency install steps run before checks; unset = lockfile detection, [] = none. */
    setup?: SetupStep[];
    /** Detected installs run lifecycle scripts (default off: `--ignore-scripts`). */
    setupScripts?: boolean;
  };
}

export type StoredProject = ProjectConfig & { matrix?: MatrixMeta };

export const iso = (d: Date | string | undefined) =>
  d === undefined ? undefined : d instanceof Date ? d.toISOString() : d;

const TIMEOUT_PHASES = ["spike", "design", "implement", "checks", "review", "qa"] as const;
const MIN_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 120 * 60_000;

function boundedMs(value: number, min: number, what: string): number {
  if (!Number.isInteger(value) || value < min || value > MAX_TIMEOUT_MS)
    throw new CoreError(
      "invalid_request",
      `${what} must be an integer between ${min} and ${MAX_TIMEOUT_MS} ms`,
    );
  return value;
}

/**
 * Applies run timeouts and implement guidance (create or PATCH). `undefined` keeps the current
 * value, `null` clears it; timeouts replace the previous overrides as a whole. Bounds are
 * re-checked here so a non-HTTP caller cannot store a 0 ms or multi-day limit.
 */
export function applyRunSettings(
  config: StoredProject,
  patch: Pick<UpdateProjectInput, "timeouts" | "idleTimeoutMs" | "implementGuidance">,
): void {
  if (patch.timeouts === null) delete config.timeouts;
  else if (patch.timeouts) {
    const timeouts: Partial<Record<Phase, number>> = {};
    for (const [phase, ms] of Object.entries(patch.timeouts as PhaseTimeoutsInput)) {
      if (ms === undefined) continue;
      if (!(TIMEOUT_PHASES as readonly string[]).includes(phase))
        throw new CoreError("invalid_request", `timeouts.${phase} is not a configurable phase`);
      timeouts[phase as Phase] = boundedMs(ms, MIN_TIMEOUT_MS, `timeouts.${phase}`);
    }
    if (Object.keys(timeouts).length) config.timeouts = timeouts;
    else delete config.timeouts;
  }
  if (patch.idleTimeoutMs === null) delete config.idleTimeoutMs;
  else if (patch.idleTimeoutMs !== undefined)
    config.idleTimeoutMs = boundedMs(patch.idleTimeoutMs, 60_000, "idleTimeoutMs");
  if (patch.implementGuidance === null) delete config.implementGuidance;
  else if (patch.implementGuidance !== undefined) {
    const text = patch.implementGuidance.trim();
    if (text.length > 4000)
      throw new CoreError("invalid_request", "implementGuidance is limited to 4000 characters");
    if (text) config.implementGuidance = text;
    else delete config.implementGuidance;
  }
}

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
    ...(config.matrix?.repo
      ? {
          repo: {
            external: true as const,
            baseBranch: config.baseBranch,
            remote: config.matrix.repo.remote,
            github: config.matrix.repo.github,
            editablePaths: [...(config.matrix.repo.editablePaths ?? [])],
            ...(config.matrix.repo.setup
              ? { setup: config.matrix.repo.setup.map((s) => ({ ...s, run: [...s.run] })) }
              : {}),
            setupScripts: config.matrix.repo.setupScripts === true,
          },
        }
      : {}),
    models: modelView(config),
    checks: config.checks.map((c) => ({ kind: c.kind, cmd: [...c.cmd] })),
    timeouts: Object.fromEntries(
      TIMEOUT_PHASES.map((phase) => [phase, phaseTimeoutMs(config, phase)]),
    ),
    ...(config.idleTimeoutMs !== undefined ? { idleTimeoutMs: config.idleTimeoutMs } : {}),
    ...(config.implementGuidance ? { implementGuidance: config.implementGuidance } : {}),
  };
}

function modelView(config: StoredProject): NonNullable<Project["models"]> {
  const out: NonNullable<Project["models"]> = {};
  for (const phase of ["spike", "design", "implement", "review", "qa"] as const) {
    const choice =
      (phase === "spike" || phase === "implement") && config.models.tiers
        ? config.models.tiers.large
        : (config.models[phase] ?? config.models.implement);
    out[phase] = { runner: choice.runner, model: choice.model };
  }
  return out;
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
    models: structuredClone(recommendedModels),
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
