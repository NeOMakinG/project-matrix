import { z } from "zod";
import { safeHttpsUrl, safeOrcaUrl } from "@/lib/safe-url";
import {
  type AdrView,
  ALL_PHASES,
  AUTONOMY_LABEL,
  type AutonomyMode,
  type FindingView,
  type GraphEdgeView,
  type GraphNodeView,
  type HoldoutView,
  LOOP_PHASES,
  type Phase,
  type PhaseState,
  type ProjectView,
  type ReceiptView,
  type RunStatus,
  type RunSummaryView,
  type RunView,
  type ServerAdr,
  type ServerGraph,
  type ServerPhase,
  type ServerProject,
  type ServerReceipt,
  type ServerRun,
  type ServerTicket,
  type TicketKind,
  type TicketView,
  type Tone,
} from "./view";

export function adaptProject(p: ServerProject): ProjectView {
  const merge = p.autonomy.merge ?? "human";
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    workspace: p.workspace,
    autonomy: p.autonomy,
    mergeLabel:
      merge === "human" ? "human merge" : merge === "gated" ? "gated merge" : "autonomous merge",
  };
}

const KIND_LABELS: Record<string, TicketKind> = {
  feature: "feature",
  bug: "bug",
  "prod-fix": "prod-fix",
  incident: "prod-fix",
  chore: "chore",
};

export function ticketKind(labels: readonly string[]): TicketKind {
  for (const label of labels) {
    const kind = KIND_LABELS[label.toLowerCase()];
    if (kind) return kind;
  }
  return "feature";
}

const isLoopPhase = (value: unknown): value is Phase =>
  typeof value === "string" && (LOOP_PHASES as readonly string[]).includes(value);

/** Board column for a ticket: its explicit loop phase, else derived from tracker status. */
export function ticketPhase(t: Pick<ServerTicket, "phase" | "status">): Phase | null {
  if (isLoopPhase(t.phase)) return t.phase;
  switch (t.status) {
    case "open":
    case "ready":
      return "spike";
    case "in_progress":
    case "blocked":
      return "implement";
    case "review":
      return "review";
    case "qa":
      return "qa";
    case "done":
      return "verify";
    default:
      return null;
  }
}

const PHASE_TONE: Record<string, Tone> = {
  spike: "violet",
  implement: "blue",
  checks: "amber",
  review: "violet",
  qa: "amber",
  merge: "green",
  deploy: "blue",
  verify: "green",
};

export function runStatus(state: string): RunStatus {
  const s = state.toLowerCase();
  if (s.includes("pause")) return "paused";
  if (["failed", "error", "timeout", "cancelled", "canceled"].some((k) => s.includes(k)))
    return "failed";
  if (["done", "merged", "verified", "succeeded", "completed", "ok"].includes(s)) return "done";
  return "running";
}

export function latestRunByTicket(runs: readonly ServerRun[]): Map<string, ServerRun> {
  const map = new Map<string, ServerRun>();
  for (const run of runs) {
    const prev = map.get(run.ticketId);
    if (!prev || prev.startedAt < run.startedAt) map.set(run.ticketId, run);
  }
  return map;
}

export function adaptTickets(
  tickets: readonly ServerTicket[],
  runs: readonly ServerRun[],
): TicketView[] {
  const byTicket = latestRunByTicket(runs);
  const out: TicketView[] = [];
  for (const t of tickets) {
    const phase = ticketPhase(t);
    if (!phase) continue;
    const run = byTicket.get(t.id);
    const kind = ticketKind(t.labels);
    const badge = run
      ? {
          label: run.model,
          tone: kind === "prod-fix" ? ("red" as Tone) : (PHASE_TONE[phase] ?? "neutral"),
        }
      : {
          label: t.status.replace("_", " "),
          tone: t.status === "blocked" ? ("amber" as Tone) : ("neutral" as Tone),
        };
    out.push({
      id: t.id,
      title: t.title,
      kind,
      phase,
      badge,
      meta: t.labels.length ? t.labels.join(" · ") : t.status.replace("_", " "),
      runId: run?.id ?? null,
    });
  }
  return out;
}

export function adaptRunSummaries(
  runs: readonly ServerRun[],
  tickets: readonly ServerTicket[],
): RunSummaryView[] {
  const titles = new Map(tickets.map((t) => [t.id, t.title]));
  return runs.map((r) => ({
    id: r.id,
    ticketId: r.ticketId,
    title: titles.get(r.ticketId) ?? r.ticketId,
    phase: r.phase,
    model: r.model,
    costUsd: r.costUsd,
    status: runStatus(r.state),
    startedAt: r.startedAt,
  }));
}

export function phaseStates(
  current: ServerPhase,
  status: RunStatus,
): { phase: Phase; state: PhaseState }[] {
  const index = (ALL_PHASES as readonly string[]).indexOf(current);
  return LOOP_PHASES.map((phase, i) => {
    let state: PhaseState = "pending";
    if (i < index || (current === "compound" && i <= index)) state = "done";
    else if (i === index)
      state = status === "failed" ? "failed" : status === "done" ? "done" : "active";
    return { phase, state };
  });
}

const reviewData = z.object({
  severity: z.enum(["P1", "P2", "P3"]),
  lane: z.string().default("review"),
  resolution: z.string().default("open"),
});
const holdoutData = z.object({
  satisfied: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  score: z.number().min(0).max(1),
  judge: z.string().default("judge"),
  pending: z.string().default(""),
});
const QA_KINDS = new Set<ReceiptView["kind"]>(["screenshot", "video", "curl", "test", "log"]);

export function adaptReceipts(receipts: readonly ServerReceipt[]): {
  findings: FindingView[];
  qa: ReceiptView[];
  holdout: HoldoutView | null;
} {
  const findings: FindingView[] = [];
  const qa: ReceiptView[] = [];
  let holdout: HoldoutView | null = null;
  receipts.forEach((r, i) => {
    if (r.kind === "review") {
      const data = reviewData.safeParse(r.data);
      if (data.success) findings.push({ id: `${i}`, text: r.summary, ...data.data });
      return;
    }
    if (r.kind === "holdout") {
      const data = holdoutData.safeParse(r.data);
      if (data.success) holdout = data.data;
      return;
    }
    if (QA_KINDS.has(r.kind as ReceiptView["kind"])) {
      qa.push({
        kind: r.kind as ReceiptView["kind"],
        label: r.summary,
        ok: r.ok,
        url: safeHttpsUrl(r.url),
      });
    }
  });
  return { findings, qa, holdout };
}

export function adaptRun(
  run: ServerRun,
  receipts: readonly ServerReceipt[],
  context: { ticketTitle?: string; mergeMode?: AutonomyMode },
): RunView {
  const status = runStatus(run.state);
  const { findings, qa, holdout } = adaptReceipts(receipts);
  return {
    id: run.id,
    projectId: run.projectId,
    ticketId: run.ticketId,
    title: context.ticketTitle ?? run.ticketId,
    startedAt: run.startedAt,
    state: run.state,
    status,
    phase: run.phase,
    phases: phaseStates(run.phase, status),
    runner: run.runner,
    model: run.model,
    workspaceUrl: safeOrcaUrl(run.workspaceUrl) ?? safeHttpsUrl(run.workspaceUrl),
    costUsd: run.costUsd,
    headSha: run.headSha && /^[0-9a-f]{7,40}$/i.test(run.headSha) ? run.headSha : null,
    findings,
    receipts: qa,
    holdout,
    mergeMode: context.mergeMode ?? "human",
  };
}

export function adaptGraph(graph: ServerGraph): { nodes: GraphNodeView[]; edges: GraphEdgeView[] } {
  const ids = new Set(graph.nodes.map((n) => n.id));
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind })),
    edges: graph.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e, i) => ({ id: `e${i}-${e.from}-${e.to}`, source: e.from, target: e.to })),
  };
}

const ADR_TONE: Record<string, Tone> = {
  accepted: "green",
  proposed: "blue",
  deprecated: "neutral",
  superseded: "neutral",
};

export function adaptAdrs(
  adrs: readonly ServerAdr[],
  violationsByAdr: ReadonlyMap<string, { errors: number; warnings: number }>,
): AdrView[] {
  return adrs.map((adr) => {
    const v = violationsByAdr.get(adr.id) ?? violationsByAdr.get(`ADR-${adr.id}`);
    let status = { label: adr.status, tone: ADR_TONE[adr.status] ?? ("neutral" as Tone) };
    if (v?.errors)
      status = { label: `${v.errors} violation${v.errors > 1 ? "s" : ""}`, tone: "red" };
    else if (v?.warnings)
      status = { label: `${v.warnings} warning${v.warnings > 1 ? "s" : ""}`, tone: "amber" };
    else if (adr.rules.length) status = { label: "passing", tone: "green" };
    return { id: adr.id, title: adr.title, path: adr.path, rules: adr.rules.length, status };
  });
}

export { AUTONOMY_LABEL };
