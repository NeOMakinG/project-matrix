import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  FigmaMcpCapability,
  Receipt,
  RunEvent,
  RunEventKind,
  Runner,
  RunnerId,
  RunRequest,
  RunResult,
} from "@matrix/core";
import { figmaConfigurationHash } from "@matrix/core";
import {
  hostExecutor,
  isReadOnlyExecutor,
  type LineExecutor,
  type SandboxApiKey,
} from "@matrix/sandbox";

export interface ParsedEvent {
  kind: RunEventKind;
  message: string;
  data?: unknown;
}

export interface ParseSummary {
  summary: string;
  isError: boolean;
  tokens?: { input: number; output: number };
  costUsd?: number;
}

export interface EventParser {
  onLine(line: string): ParsedEvent[];
  finish(): ParseSummary;
  /**
   * True once the CLI's final event (claude's `result`, codex's `turn.completed`) was parsed. The
   * run is then over: a process that lingers past the completion grace period is stopped.
   */
  isComplete?(): boolean;
}

/** Where model traffic goes. Inside a sandbox `apiKey` is a per-run token, never the real gateway key. */
export interface GatewayConfig {
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  /** A run token or the placeholder the sandbox fills; a real key does not typecheck. */
  apiKey: SandboxApiKey;
}

export interface CliRunnerOptions {
  figmaMcp?: { serverName: string; url: string; policySha256?: string; hostCaptureOnly?: boolean };
  gateway: GatewayConfig;
  executor?: LineExecutor;
  /** Absolute binary path or name resolved on PATH inside the execution environment. */
  binary?: string;
  /** Pass the CLI's skip-permission flag. Only safe when the executor is a sandbox. */
  skipPermissions?: boolean;
  /** Base environment (PATH, HOME…). Never pass the host environment wholesale. */
  baseEnv?: Record<string, string>;
  /** Writes the raw event stream here and adds a `log` receipt. */
  transcriptPath?: (req: RunRequest) => string;
  now?: () => Date;
  /** No output for this long ends the run as "runner idle". Default 10 min; 0 disables. */
  idleTimeoutMs?: number;
  /** After the final event, how long the CLI may take to exit on its own. Default 30 s. */
  completionGraceMs?: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_COMPLETION_GRACE_MS = 30_000;

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 6_000) / 10} min`;
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

export interface CommandSpec {
  cmd: string[];
  env: Record<string, string>;
  stdin?: string;
}

export interface CliRunnerDefinition {
  supportsFigmaMcp?: boolean;
  id: RunnerId;
  defaultBinary: string;
  command(
    req: RunRequest,
    opts: Required<Pick<CliRunnerOptions, "gateway">> & CliRunnerOptions,
  ): CommandSpec;
  parser(): EventParser;
}

const MAX_EVENT_MESSAGE = 4000;
/** Raw event stream kept for the transcript receipt; events past this are still parsed, not stored. */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export function truncate(text: string, max = MAX_EVENT_MESSAGE): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

export function defaultBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "TERM", "TMPDIR", "USER"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function createCliRunner(
  definition: CliRunnerDefinition,
  options: CliRunnerOptions,
): Runner {
  const executor = options.executor ?? hostExecutor;
  const now = options.now ?? (() => new Date());
  let figmaMcp: FigmaMcpCapability | undefined;
  if (options.figmaMcp && definition.supportsFigmaMcp) {
    const { serverName, url, policySha256 } = options.figmaMcp;
    const endpoint = new URL(url);
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(serverName) ||
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("invalid Figma MCP configuration");
    figmaMcp = Object.freeze({
      serverName,
      url,
      ...(policySha256 ? { policySha256 } : {}),
      configurationSha256: figmaConfigurationHash({
        serverName,
        url,
        ...(policySha256 ? { policySha256 } : {}),
      }),
    });
  }
  const configuredOptions = figmaMcp
    ? {
        ...options,
        figmaMcp: {
          serverName: figmaMcp.serverName,
          url: figmaMcp.url,
          ...(options.figmaMcp?.hostCaptureOnly ? { hostCaptureOnly: true } : {}),
        },
      }
    : options;
  return {
    id: definition.id,
    ...(isReadOnlyExecutor(executor) ? { readOnlyIsolation: "os" as const } : {}),
    ...(figmaMcp ? { figmaMcp } : {}),
    async run(
      req: RunRequest,
      onEvent: (event: RunEvent) => void,
      signal: AbortSignal,
    ): Promise<RunResult> {
      if ((req.readOnly || req.phase === "design") && !isReadOnlyExecutor(executor))
        throw new Error(
          "read-only run requires executor-enforced OS isolation; host fallback is forbidden",
        );
      const spec = definition.command(req, configuredOptions);
      const parser = definition.parser();
      const raw: string[] = [];
      let rawBytes = 0;
      let rawTruncated = false;
      const emit = (event: ParsedEvent) =>
        onEvent({ runId: req.runId, at: now().toISOString(), ...event });
      const env = { ...(options.baseEnv ?? defaultBaseEnv()), ...spec.env, ...(req.env ?? {}) };
      // The executor gets our own signal so a finished-but-lingering or silent CLI can be stopped
      // (SIGTERM, then SIGKILL) without being reported as a user cancellation.
      const idleMs = req.idleTimeoutMs ?? options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      const graceMs = options.completionGraceMs ?? DEFAULT_COMPLETION_GRACE_MS;
      const controller = new AbortController();
      let stopReason: "completed" | "idle" | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (reason: "completed" | "idle") => {
        if (controller.signal.aborted) return;
        stopReason = reason;
        controller.abort();
      };
      const armIdle = () => {
        clearTimeout(idleTimer);
        if (idleMs > 0 && graceTimer === undefined)
          idleTimer = setTimeout(() => stop("idle"), idleMs);
      };
      const forwardAbort = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
      armIdle();
      let outcome: Awaited<ReturnType<LineExecutor>>;
      try {
        outcome = await executor(
          {
            cmd: spec.cmd,
            cwd: req.workdir,
            env,
            ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
            timeoutMs: req.timeoutMs,
            ...(req.readOnly || req.phase === "design" ? { readOnly: true } : {}),
          },
          (line) => {
            rawBytes += line.length + 1;
            if (rawBytes <= MAX_TRANSCRIPT_BYTES) raw.push(line);
            else if (!rawTruncated) {
              rawTruncated = true;
              raw.push(`[transcript truncated at ${MAX_TRANSCRIPT_BYTES} bytes]`);
            }
            for (const event of parser.onLine(line)) emit(event);
            if (graceTimer === undefined && parser.isComplete?.()) {
              clearTimeout(idleTimer);
              graceTimer = setTimeout(() => stop("completed"), graceMs);
            }
            armIdle();
          },
          controller.signal,
        );
      } finally {
        clearTimeout(idleTimer);
        clearTimeout(graceTimer);
        signal.removeEventListener("abort", forwardAbort);
      }
      // Our stop only counts if the executor saw the abort: a process that already exited (while the
      // executor cleaned up) keeps its real exit code. A caller abort after the final event does not
      // discard the finished work.
      const stoppedBy = !outcome.cancelled
        ? undefined
        : (stopReason ?? (parser.isComplete?.() ? "completed" : undefined));
      const parsed = parser.finish();
      const receipts: Receipt[] = [];
      if (options.transcriptPath) {
        const path = options.transcriptPath(req);
        const body = `${raw.join("\n")}\n`;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, body, "utf8");
        receipts.push({
          kind: "log",
          ok: true,
          summary: `${definition.id} transcript (${raw.length} events)`,
          path,
          sha256: createHash("sha256").update(body).digest("hex"),
        });
      }
      let status: RunResult["status"];
      if (stoppedBy === "idle") status = "failed";
      // The final event arrived; the stop signal is ours, so the parsed result decides.
      else if (stoppedBy === "completed") status = parsed.isError ? "failed" : "ok";
      else if (outcome.cancelled) status = "cancelled";
      else if (outcome.timedOut) status = "timeout";
      else if (outcome.exitCode !== 0 || parsed.isError) status = "failed";
      else status = "ok";
      let summary = parsed.summary;
      const interruption =
        stoppedBy === "idle"
          ? `runner idle: no output for ${formatDuration(idleMs)}`
          : status === "failed" && stoppedBy !== "completed"
            ? interruptionOf(outcome)
            : undefined;
      if (interruption)
        // The real cause leads (it becomes the workflow's last error); the model's last message
        // is kept below it as context only.
        summary = truncate(
          `run interrupted: ${definition.id} ${interruption}${parsed.summary ? `\nlast model message (context): ${parsed.summary}` : ""}`,
        );
      if (status !== "ok" && outcome.stderrTail.trim()) {
        summary = truncate(`${summary}\n${outcome.stderrTail.trim()}`.trim());
      }
      if (status === "failed" && !summary)
        summary = `${definition.id} exited with code ${outcome.exitCode}`;
      emit({
        kind: "done",
        message: `${definition.id} ${status}`,
        data: { exitCode: outcome.exitCode, ...(stoppedBy ? { stopReason: stoppedBy } : {}) },
      });
      return {
        runId: req.runId,
        status,
        summary,
        ...(parsed.tokens ? { tokens: parsed.tokens } : {}),
        ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
        receipts,
      };
    },
  };
}

const SIGNALS: Record<number, string> = { 1: "SIGHUP", 2: "SIGINT", 9: "SIGKILL", 15: "SIGTERM" };

/**
 * Why a process did not end on its own, or undefined for an ordinary exit. Container runtimes
 * report a killed or stopped container as 128 + signal (137 = SIGKILL, 143 = SIGTERM).
 */
export function interruptionOf(outcome: {
  exitCode: number;
  interrupted?: string;
}): string | undefined {
  if (outcome.interrupted) return outcome.interrupted;
  const signal = SIGNALS[outcome.exitCode - 128];
  if (signal) return `exited ${outcome.exitCode} (${signal}: container stopped or killed)`;
  return undefined;
}

export function safeJson(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
