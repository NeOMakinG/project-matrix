export const PHASES = [
  "spike",
  "design",
  "implement",
  "checks",
  "review",
  "qa",
  "merge",
  "deploy",
  "verify",
  "compound",
] as const;
export type Phase = (typeof PHASES)[number];

export type RunnerId = "claude-code" | "codex" | "opencode";

export type ReceiptKind =
  | "design"
  | "test"
  | "lint"
  | "typecheck"
  | "adr-check"
  | "review"
  | "screenshot"
  | "video"
  | "curl"
  | "log"
  | "holdout"
  | "secret-scan";

export interface Receipt {
  kind: ReceiptKind;
  ok: boolean;
  summary: string;
  path?: string;
  url?: string;
  sha256?: string;
  data?: unknown;
}

export interface RunRequest {
  runId: string;
  projectId: string;
  ticketId: string;
  phase: Phase;
  runner: RunnerId;
  model: string;
  prompt: string;
  workdir: string;
  /** Mount the workdir read-only (review and judge runs). */
  readOnly?: boolean;
  env?: Record<string, string>;
  timeoutMs: number;
}

export type RunEventKind = "log" | "tool" | "file" | "cost" | "error" | "done";

export interface RunEvent {
  runId: string;
  at: string;
  kind: RunEventKind;
  message: string;
  data?: unknown;
}

export type RunStatus = "ok" | "failed" | "timeout" | "cancelled";

export interface RunResult {
  runId: string;
  status: RunStatus;
  summary: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  receipts: Receipt[];
}

export interface Runner {
  readonly readOnlyIsolation?: "os";
  readonly id: RunnerId;
  readonly figmaMcp?: FigmaMcpCapability;
  run(req: RunRequest, onEvent: (event: RunEvent) => void, signal: AbortSignal): Promise<RunResult>;
}

export interface FigmaMcpCapability {
  serverName: string;
  url: string;
  policySha256?: string;
  configurationSha256: string;
}

export type NetworkPolicy = "none" | "gateway" | "allowlist";

export interface SandboxExecSpec {
  workdir: string;
  cmd: string[];
  env?: Record<string, string>;
  network: NetworkPolicy;
  allowHosts?: string[];
  timeoutMs: number;
}

export interface SandboxExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  readonly kind: "podman" | "bwrap";
  exec(spec: SandboxExecSpec, signal?: AbortSignal): Promise<SandboxExecResult>;
}

export interface WorkspaceTarget {
  projectId: string;
  ticketId: string;
  repoPath: string;
  branch: string;
  baseBranch: string;
}

export interface PreparedWorkspace {
  workdir: string;
  ref: string;
  url?: string;
}

export interface Workspace {
  readonly kind: "orca" | "native";
  prepare(target: WorkspaceTarget): Promise<PreparedWorkspace>;
  cleanup(prepared: PreparedWorkspace): Promise<void>;
}

export type AutonomyMode = "human" | "gated" | "autonomous";
