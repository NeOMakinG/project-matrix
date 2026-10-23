import { recommendedModels } from "@matrix/config";
import {
  type ApprovalRecord,
  type AutonomyMode,
  autonomyFor,
  CHECK_PARSERS,
  type CheckCommand,
  PHASES,
  type Phase,
  type ProjectConfig,
  phaseTimeoutMs,
  QA_SURFACES,
  REVIEW_LANES,
  type RunRecord,
} from "@matrix/core";
import {
  type Approval,
  type CheckSpec,
  CoreError,
  type PhaseResourcesInput,
  type PhaseTimeoutsInput,
  type Project,
  type QaSettingsInput,
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
/** Per-run ceilings (the host clamps further with MATRIX_SANDBOX_MAX_*). */
const MAX_SANDBOX_CPUS = 128;
const MAX_SANDBOX_MEMORY_GB = 512;
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

/** Re-checks a resource request for non-HTTP callers (same bounds as the HTTP schema). */
function boundedResources(
  r: { cpus?: number | undefined; memoryGb?: number | undefined },
  what: string,
): { cpus?: number; memoryGb?: number } {
  const out: { cpus?: number; memoryGb?: number } = {};
  if (r.cpus !== undefined) {
    if (!Number.isFinite(r.cpus) || r.cpus < 0.5 || r.cpus > MAX_SANDBOX_CPUS)
      throw new CoreError("invalid_request", `${what}.cpus must be 0.5-${MAX_SANDBOX_CPUS}`);
    out.cpus = r.cpus;
  }
  if (r.memoryGb !== undefined) {
    if (!Number.isInteger(r.memoryGb) || r.memoryGb < 1 || r.memoryGb > MAX_SANDBOX_MEMORY_GB)
      throw new CoreError(
        "invalid_request",
        `${what}.memoryGb must be an integer 1-${MAX_SANDBOX_MEMORY_GB}`,
      );
    out.memoryGb = r.memoryGb;
  }
  return out;
}

/**
 * Applies run timeouts and implement guidance (create or PATCH). `undefined` keeps the current
 * value, `null` clears it; timeouts replace the previous overrides as a whole. Bounds are
 * re-checked here so a non-HTTP caller cannot store a 0 ms or multi-day limit.
 */
export function applyRunSettings(
  config: StoredProject,
  patch: Pick<
    UpdateProjectInput,
    "timeouts" | "idleTimeoutMs" | "implementGuidance" | "resources" | "baselineWarmup" | "qa"
  >,
): void {
  if (patch.resources === null) delete config.resources;
  else if (patch.resources) {
    const resources: NonNullable<StoredProject["resources"]> = {};
    for (const [phase, r] of Object.entries(patch.resources as PhaseResourcesInput)) {
      if (r === undefined) continue;
      if (!(TIMEOUT_PHASES as readonly string[]).includes(phase))
        throw new CoreError("invalid_request", `resources.${phase} is not a configurable phase`);
      resources[phase as Phase] = boundedResources(r, `resources.${phase}`);
    }
    if (Object.keys(resources).length) config.resources = resources;
    else delete config.resources;
  }
  if (patch.baselineWarmup !== undefined) {
    if (patch.baselineWarmup) config.baselineWarmup = true;
    else delete config.baselineWarmup;
  }
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
  if (patch.qa === null) delete config.qa;
  else if (patch.qa !== undefined) {
    const qa = validQaSettings(patch.qa);
    if (qa.surfaces?.length || qa.driver) config.qa = qa;
    else delete config.qa;
  }
  if (patch.implementGuidance === null) delete config.implementGuidance;
  else if (patch.implementGuidance !== undefined) {
    const text = patch.implementGuidance.trim();
    if (text.length > 4000)
      throw new CoreError("invalid_request", "implementGuidance is limited to 4000 characters");
    if (text) config.implementGuidance = text;
    else delete config.implementGuidance;
  }
}

/** Re-checked here so non-HTTP callers cannot store unknown surfaces or drivers. */
export function validQaSettings(input: QaSettingsInput): NonNullable<StoredProject["qa"]> {
  const surfaces = [...new Set(input.surfaces ?? [])];
  for (const surface of surfaces)
    if (!(QA_SURFACES as readonly string[]).includes(surface))
      throw new CoreError("invalid_request", `unknown qa surface ${String(surface).slice(0, 20)}`);
  if (input.driver !== undefined && input.driver !== "none" && input.driver !== "manual")
    throw new CoreError("invalid_request", "qa.driver must be none or manual");
  return {
    ...(surfaces.length ? { surfaces } : {}),
    ...(input.driver === "manual" ? { driver: "manual" as const } : {}),
  };
}

const PARSERS: readonly string[] = CHECK_PARSERS;

/** Validated copy of a check (non-HTTP callers included): argv, kind, parser, baseline mode. */
export function copyCheck(c: CheckSpec): CheckCommand {
  if (c.parser !== undefined && !PARSERS.includes(c.parser))
    throw new CoreError("invalid_request", `unknown check parser ${String(c.parser).slice(0, 40)}`);
  if (c.baseline !== undefined && c.baseline !== "compare" && c.baseline !== "strict")
    throw new CoreError("invalid_request", "check baseline must be compare or strict");
  if (c.retryFlaky !== undefined && typeof c.retryFlaky !== "boolean")
    throw new CoreError("invalid_request", "check retryFlaky must be a boolean");
  return {
    kind: c.kind,
    cmd: [...c.cmd],
    ...(c.parser ? { parser: c.parser } : {}),
    ...(c.baseline ? { baseline: c.baseline } : {}),
    ...(c.retryFlaky !== undefined ? { retryFlaky: c.retryFlaky } : {}),
  };
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
    checks: config.checks.map(copyCheck),
    timeouts: Object.fromEntries(
      TIMEOUT_PHASES.map((phase) => [phase, phaseTimeoutMs(config, phase)]),
    ),
    ...(config.resources
      ? {
          resources: Object.fromEntries(
            Object.entries(config.resources).map(([phase, r]) => [phase, { ...r }]),
          ),
        }
      : {}),
    ...(config.baselineWarmup ? { baselineWarmup: true } : {}),
    ...(config.idleTimeoutMs !== undefined ? { idleTimeoutMs: config.idleTimeoutMs } : {}),
    ...(config.implementGuidance ? { implementGuidance: config.implementGuidance } : {}),
    ...(config.qa
      ? {
          qa: {
            ...(config.qa.surfaces ? { surfaces: [...config.qa.surfaces] } : {}),
            driver: config.qa.driver ?? "none",
          },
        }
      : {}),
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
