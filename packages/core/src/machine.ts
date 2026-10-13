import { designEvidence } from "./design.js";
import { isTrustedHoldout } from "./holdout.js";
import { type AutonomyMode, PHASES, type Phase, type Receipt } from "./ports.js";
import type {
  BackoffPolicy,
  PhaseOutcome,
  ProjectConfig,
  ReviewFinding,
  WorkflowState,
} from "./types.js";

export type Effect =
  | { type: "request_approval"; phase: Phase }
  | { type: "blocked"; reason: string }
  | { type: "done" };

export interface Transition {
  state: WorkflowState;
  effects: Effect[];
}

const QA_EVIDENCE = new Set(["screenshot", "video", "curl", "test"]);
const CHECK_KINDS = new Set(["typecheck", "lint", "test", "adr-check"]);
const LOOP_BACK: ReadonlySet<Phase> = new Set(["checks", "review", "qa", "verify"]);

export function autonomyFor(config: ProjectConfig, phase: Phase): AutonomyMode {
  return config.autonomy[phase] ?? config.autonomy.default;
}

export function requiresApproval(mode: AutonomyMode, phase: Phase): boolean {
  if (mode === "human") return phase === "design" || phase === "merge" || phase === "deploy";
  if (mode === "gated") return phase === "deploy";
  return false;
}

export function backoffMs(attempt: number, policy: BackoffPolicy): number {
  return Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
}

export function findingsOf(receipt: Receipt): ReviewFinding[] {
  const data = receipt.data as { findings?: ReviewFinding[] } | undefined;
  return Array.isArray(data?.findings) ? data.findings : [];
}

export interface GateResult {
  pass: boolean;
  reason: string;
}

export function gate(phase: Phase, outcome: PhaseOutcome, config: ProjectConfig): GateResult {
  const r = outcome.receipts;
  switch (phase) {
    case "design": {
      const designs = r.filter((receipt) => receipt.kind === "design");
      return outcome.ok && designs.length > 0 && designs.every((receipt) => designEvidence(receipt))
        ? { pass: true, reason: "verified Figma design evidence" }
        : { pass: false, reason: "missing or invalid Figma design receipts" };
    }
    case "checks": {
      const checks = r.filter((x) => CHECK_KINDS.has(x.kind));
      if (checks.length === 0) return { pass: false, reason: "no check receipts" };
      const failed = checks.filter((x) => !x.ok).map((x) => x.kind);
      return failed.length
        ? { pass: false, reason: `checks failed: ${failed.join(", ")}` }
        : { pass: true, reason: "all checks passed" };
    }
    case "review": {
      const reviews = r.filter((x) => x.kind === "review");
      if (reviews.length === 0) return { pass: false, reason: "no review receipts" };
      const p1 = reviews.flatMap(findingsOf).filter((f) => f.severity === "P1");
      return p1.length
        ? { pass: false, reason: `P1 findings: ${p1.map((f) => f.title).join("; ")}` }
        : { pass: true, reason: "no P1 findings" };
    }
    case "qa": {
      const evidence = r.filter((x) => QA_EVIDENCE.has(x.kind));
      if (evidence.length === 0) return { pass: false, reason: "no QA receipts" };
      if (evidence.some((x) => !x.ok)) return { pass: false, reason: "QA receipt failed" };
      const holdout = r.filter(isTrustedHoldout).at(-1);
      const satisfaction = (holdout?.data as { satisfaction?: number } | undefined)?.satisfaction;
      if (typeof satisfaction !== "number") return { pass: false, reason: "no holdout score" };
      return satisfaction >= config.holdoutThreshold
        ? { pass: true, reason: `holdout ${satisfaction}` }
        : { pass: false, reason: `holdout ${satisfaction} < ${config.holdoutThreshold}` };
    }
    default:
      return outcome.ok
        ? { pass: true, reason: outcome.summary }
        : { pass: false, reason: outcome.summary };
  }
}

function nextPhase(phase: Phase): Phase | undefined {
  return PHASES[PHASES.indexOf(phase) + 1];
}

function enter(state: WorkflowState, phase: Phase, config: ProjectConfig): Transition {
  const base: WorkflowState = { ...state, phase, attempt: 0, status: "pending" };
  delete base.nextAttemptAt;
  delete base.lastError;
  if (phase !== "design" && requiresApproval(autonomyFor(config, phase), phase)) {
    return {
      state: { ...base, status: "waiting_approval" },
      effects: [{ type: "request_approval", phase }],
    };
  }
  return { state: base, effects: [] };
}

function block(state: WorkflowState, reason: string): Transition {
  return {
    state: { ...state, status: "blocked", lastError: reason },
    effects: [{ type: "blocked", reason }],
  };
}

export function advance(
  state: WorkflowState,
  outcome: PhaseOutcome,
  config: ProjectConfig,
  backoff: BackoffPolicy,
  now: Date,
): Transition {
  if (outcome.failureClass === "factory-tooling")
    return block(state, `factory/tooling error at ${state.phase}: ${outcome.summary}`);
  if (outcome.restartDesign) {
    const loops = state.loops + 1;
    if (loops > config.maxLoops) return block({ ...state, loops }, outcome.summary);
    const next = enter({ ...state, loops }, "design", config);
    return { ...next, state: { ...next.state, lastError: outcome.summary } };
  }
  if (outcome.blocked) return block(state, outcome.summary);
  if (outcome.requiresApproval && (state.phase === "merge" || state.phase === "deploy")) {
    // Autonomy changed or the approval no longer matches: stop and ask again instead of acting.
    return {
      state: { ...state, status: "waiting_approval", lastError: outcome.summary },
      effects: [{ type: "request_approval", phase: state.phase }],
    };
  }
  const crashed = outcome.runStatus !== undefined && outcome.runStatus !== "ok";
  const softFail =
    !crashed && !outcome.ok && (state.phase === "spike" || state.phase === "implement");
  if (crashed || softFail) {
    const attempt = state.attempt + 1;
    if (attempt >= config.maxAttempts) {
      return block({ ...state, attempt }, `${state.phase} failed ${attempt}x: ${outcome.summary}`);
    }
    return {
      state: {
        ...state,
        attempt,
        status: "pending",
        lastError: outcome.summary,
        nextAttemptAt: new Date(now.getTime() + backoffMs(attempt, backoff)),
      },
      effects: [],
    };
  }

  const result = gate(state.phase, outcome, config);
  const withModel =
    state.phase === "implement" && outcome.model
      ? { ...state, implementerModel: outcome.model }
      : state;

  if (result.pass) {
    if (
      state.phase === "design" &&
      requiresApproval(autonomyFor(config, "design"), "design") &&
      !outcome.designApproved
    ) {
      return {
        state: { ...state, status: "waiting_approval" },
        effects: [{ type: "request_approval", phase: "design" }],
      };
    }
    const next =
      state.phase === "spike"
        ? config.agents?.designFirst && outcome.targetsUi
          ? "design"
          : "implement"
        : nextPhase(state.phase);
    if (!next) {
      return { state: { ...withModel, status: "done" }, effects: [{ type: "done" }] };
    }
    return enter(withModel, next, config);
  }

  if (LOOP_BACK.has(state.phase)) {
    const loops = state.loops + 1;
    if (loops > config.maxLoops) {
      return block(
        { ...withModel, loops },
        `loop limit reached at ${state.phase}: ${result.reason}`,
      );
    }
    const looped = enter({ ...withModel, loops }, "implement", config);
    return { ...looped, state: { ...looped.state, lastError: result.reason } };
  }

  return block(withModel, `${state.phase} gate failed: ${result.reason}`);
}

export function approve(state: WorkflowState): WorkflowState {
  if (state.status !== "waiting_approval") return state;
  return { ...state, status: "pending" };
}

export function reject(state: WorkflowState, config: ProjectConfig, reason: string): Transition {
  if (state.status !== "waiting_approval") return { state, effects: [] };
  const loops = state.loops + 1;
  if (loops > config.maxLoops) return block({ ...state, loops }, `rejected: ${reason}`);
  const looped = enter(
    { ...state, loops },
    state.phase === "design" ? "design" : "implement",
    config,
  );
  return { ...looped, state: { ...looped.state, lastError: `rejected: ${reason}` } };
}

export function initialState(projectId: string, ticketId: string, priority = 2): WorkflowState {
  return {
    projectId,
    ticketId,
    phase: "spike",
    status: "pending",
    attempt: 0,
    loops: 0,
    priority,
    version: 0,
  };
}
