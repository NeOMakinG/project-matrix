import type { SandboxResourceRequest } from "./types.js";

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
  /** Runner machine when not the project host (the runtime routes the run there). */
  host?: string;
  /** Mount the workdir read-only (review and judge runs). */
  readOnly?: boolean;
  env?: Record<string, string>;
  timeoutMs: number;
  /** No output for this long stops the run as idle; overrides the runner's default. */
  idleTimeoutMs?: number;
  /** Container CPU/memory for this run (project per-phase setting; host clamps it). */
  resources?: SandboxResourceRequest;
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
  /** Runner machine when not the project host (the runtime routes the command there). */
  host?: string;
  cmd: string[];
  env?: Record<string, string>;
  network: NetworkPolicy;
  allowHosts?: string[];
  timeoutMs: number;
  maxOutputBytes?: number;
  readOnly?: boolean;
  /** Container CPU/memory (project per-phase setting; the sandbox clamps it to host bounds). */
  resources?: SandboxResourceRequest;
  /**
   * Structured report the command writes to `REPORT_MOUNT/<name>` (eslint -o, vitest
   * --outputFile, node:test reporter destination). The sandbox mounts a fresh host-only directory
   * there, then reads the file host-side (regular file only, no symlink, at most `maxBytes`).
   */
  report?: { name: string; maxBytes: number };
}

/** Where the host-only report directory of `SandboxExecSpec.report` appears inside the sandbox. */
export const REPORT_MOUNT = "/matrix-report";

export interface SandboxExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Contents of the requested report file, or why it is unusable (missing, too big, not a file). */
  report?: { text: string } | { error: string };
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
