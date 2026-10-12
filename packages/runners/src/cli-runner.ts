import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Receipt,
  RunEvent,
  RunEventKind,
  Runner,
  RunnerId,
  RunRequest,
  RunResult,
} from "@matrix/core";
import { hostExecutor, type LineExecutor, type SandboxApiKey } from "@matrix/sandbox";

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
}

/** Where model traffic goes. Inside a sandbox `apiKey` is a per-run token, never the real gateway key. */
export interface GatewayConfig {
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  /** A run token or the placeholder the sandbox fills; a real key does not typecheck. */
  apiKey: SandboxApiKey;
}

export interface CliRunnerOptions {
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
}

export interface CommandSpec {
  cmd: string[];
  env: Record<string, string>;
  stdin?: string;
}

export interface CliRunnerDefinition {
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
  return {
    id: definition.id,
    async run(
      req: RunRequest,
      onEvent: (event: RunEvent) => void,
      signal: AbortSignal,
    ): Promise<RunResult> {
      const spec = definition.command(req, options);
      const parser = definition.parser();
      const raw: string[] = [];
      let rawBytes = 0;
      let rawTruncated = false;
      const emit = (event: ParsedEvent) =>
        onEvent({ runId: req.runId, at: now().toISOString(), ...event });
      const env = { ...(options.baseEnv ?? defaultBaseEnv()), ...spec.env, ...(req.env ?? {}) };
      const outcome = await executor(
        {
          cmd: spec.cmd,
          cwd: req.workdir,
          env,
          ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
          timeoutMs: req.timeoutMs,
          ...(req.readOnly ? { readOnly: true } : {}),
        },
        (line) => {
          rawBytes += line.length + 1;
          if (rawBytes <= MAX_TRANSCRIPT_BYTES) raw.push(line);
          else if (!rawTruncated) {
            rawTruncated = true;
            raw.push(`[transcript truncated at ${MAX_TRANSCRIPT_BYTES} bytes]`);
          }
          for (const event of parser.onLine(line)) emit(event);
        },
        signal,
      );
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
      if (outcome.cancelled) status = "cancelled";
      else if (outcome.timedOut) status = "timeout";
      else if (outcome.exitCode !== 0 || parsed.isError) status = "failed";
      else status = "ok";
      let summary = parsed.summary;
      if (status !== "ok" && outcome.stderrTail.trim()) {
        summary = truncate(`${summary}\n${outcome.stderrTail.trim()}`.trim());
      }
      if (status === "failed" && !summary)
        summary = `${definition.id} exited with code ${outcome.exitCode}`;
      emit({
        kind: "done",
        message: `${definition.id} ${status}`,
        data: { exitCode: outcome.exitCode },
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
