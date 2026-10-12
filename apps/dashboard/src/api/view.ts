import type { PillData, Tone } from "./contracts";
import type { components } from "./generated/v1";

export type { PillData, Tone };
export type S = components["schemas"];
export type ServerProject = S["Project"];
export type ServerTicket = S["Ticket"];
export type ServerRun = S["Run"];
export type ServerReceipt = S["Receipt"];
export type ServerAdr = S["Adr"];
export type ServerGraph = S["ProductGraph"];
export type ApiKey = S["ApiKey"];
export type KeyAction = S["KeyScope"]["actions"][number];
export type AutonomyMode = S["AutonomyMode"];
export type ServerPhase = S["Phase"];
export type ServerOverview = S["Overview"];
export type ModelHealth = S["ModelHealth"];
export type OrcaRuntime = S["OrcaRuntime"];
export type Incident = S["Incident"];
export type Approval = S["Approval"];
export type InitProgress = S["InitProgress"];
export type CheckResult = S["CheckResult"];
export type Integration = S["Integration"];

export const LOOP_PHASES = [
  "spike",
  "implement",
  "checks",
  "review",
  "qa",
  "merge",
  "deploy",
  "verify",
] as const satisfies readonly ServerPhase[];
export type Phase = (typeof LOOP_PHASES)[number];

export const ALL_PHASES = [...LOOP_PHASES, "compound"] as const satisfies readonly ServerPhase[];

export const KEY_ACTIONS = [
  "read",
  "tickets:write",
  "runs:start",
  "runs:approve",
  "merge",
  "deploy",
  "admin",
] as const satisfies readonly KeyAction[];

export const AUTONOMY_MODES = [
  "human",
  "gated",
  "autonomous",
] as const satisfies readonly AutonomyMode[];
export const AUTONOMY_LABEL: Record<AutonomyMode, string> = {
  human: "human approval",
  gated: "gated (holdout + review)",
  autonomous: "autonomous",
};

export type TicketKind = "feature" | "bug" | "prod-fix" | "chore";

export interface ProjectView {
  id: string;
  name: string;
  description: string;
  workspace: "orca" | "native";
  autonomy: Record<string, AutonomyMode>;
  mergeLabel: string;
}

export interface TicketView {
  id: string;
  title: string;
  kind: TicketKind;
  phase: Phase;
  badge: PillData;
  meta: string;
  runId: string | null;
}

export type RunStatus = "running" | "paused" | "done" | "failed";

export interface RunSummaryView {
  id: string;
  ticketId: string;
  title: string;
  phase: ServerPhase;
  model: string;
  costUsd: number;
  status: RunStatus;
  startedAt: string;
}

export type PhaseState = "done" | "active" | "pending" | "failed";

export interface FindingView {
  id: string;
  severity: "P1" | "P2" | "P3";
  lane: string;
  text: string;
  resolution: string;
}

export interface ReceiptView {
  kind: "screenshot" | "video" | "curl" | "test" | "log";
  label: string;
  ok: boolean;
  url: string | null;
}

export interface HoldoutView {
  satisfied: number;
  total: number;
  score: number;
  judge: string;
  pending: string;
}

export interface RunView {
  id: string;
  projectId: string;
  ticketId: string;
  title: string;
  startedAt: string;
  state: string;
  status: RunStatus;
  phase: ServerPhase;
  phases: { phase: Phase; state: PhaseState }[];
  runner: string;
  model: string;
  workspaceUrl: string | null;
  costUsd: number;
  headSha: string | null;
  findings: FindingView[];
  receipts: ReceiptView[];
  holdout: HoldoutView | null;
  mergeMode: AutonomyMode;
  approval: { id: string; headSha: string } | null;
  pullRequestUrl: string | null;
}

export interface RunEvent {
  runId: string;
  at: string;
  kind: "log" | "tool" | "file" | "cost" | "error" | "done";
  message: string;
}

export interface GraphNodeView {
  id: string;
  label: string;
  kind: string;
}

export interface GraphEdgeView {
  id: string;
  source: string;
  target: string;
}

export interface AdrView {
  id: string;
  title: string;
  path: string;
  rules: number;
  status: PillData;
}

export interface SettingsView {
  autonomy: { phase: ServerPhase; mode: AutonomyMode }[];
  runners: { phase: string; runner: string; model: string }[];
  runnerOptions: string[];
  modelOptions: string[];
  raw: S["Settings"];
  etag: string | null;
}

export interface OverviewView {
  stats: {
    activeRuns: number;
    queuedRuns: number;
    costTodayUsd: number;
    pendingApprovals: number;
    openIncidents: number;
  };
  activeRuns: {
    id: string;
    projectId: string;
    ticketId: string;
    phase: string;
    model: string;
    costUsd: number;
    status: PillData;
  }[];
  projects: {
    id: string;
    name: string;
    workspace: string;
    summary: string;
    status: PillData;
  }[];
  models: { id: string; note: string; usage: number | null; status: PillData }[];
  orca: { status: PillData; host: string; version: string; worktrees: string; lastSeen: string };
  alerts: { kind: PillData; message: string }[];
}
