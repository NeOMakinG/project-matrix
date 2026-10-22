import { isAbsolute } from "node:path";
import { hostExecutor, type LineExecutor, runToCompletion } from "@matrix/sandbox";

/**
 * Default Orca IDE CLI on a Linux host. Never resolve `orca` through PATH: on many Linux desktops
 * `/usr/bin/orca` is the GNOME screen reader, not the Orca IDE.
 */
export const DEFAULT_ORCA_BINARY = "/opt/Orca/resources/bin/orca-ide";

export interface OrcaCliOptions {
  /** Absolute path to the Orca IDE CLI. */
  binary?: string;
  executor?: LineExecutor;
  /** Orca runtime environment to target (paired remote). Omit to use the local runtime. */
  environment?: string;
  timeoutMs?: number;
}

interface OrcaEnvelope {
  ok?: boolean;
  result?: unknown;
  error?: { message?: string; code?: string } | string;
}

export class OrcaCliError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Thin JSON-envelope client over the Orca CLI. Arguments are argv, never a shell string. */
export class OrcaCli {
  readonly binary: string;
  readonly #o: OrcaCliOptions;

  constructor(options: OrcaCliOptions = {}) {
    const binary = options.binary ?? DEFAULT_ORCA_BINARY;
    if (!isAbsolute(binary))
      throw new Error(`Orca CLI must be an absolute path (got ${JSON.stringify(binary)})`);
    this.binary = binary;
    this.#o = options;
  }

  get environment(): string | undefined {
    return this.#o.environment;
  }

  async call(args: string[], timeoutMs?: number): Promise<unknown> {
    const full = [...args];
    if (this.#o.environment) full.push("--environment", this.#o.environment);
    const result = await runToCompletion(this.#o.executor ?? hostExecutor, {
      cmd: [this.binary, ...full],
      cwd: process.env.HOME ?? "/tmp",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
      timeoutMs: timeoutMs ?? this.#o.timeoutMs ?? 120_000,
    });
    const label = `orca ${args.slice(0, 2).join(" ")}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new OrcaCliError(
        `${label} returned non-JSON (exit ${result.exitCode}): ${result.stderrTail.trim().slice(-300)}`,
      );
    }
    const envelope = record(parsed) as OrcaEnvelope;
    if (result.exitCode !== 0 || envelope.ok === false) {
      const error = envelope.error;
      const message = typeof error === "string" ? error : error?.message;
      const code = typeof error === "object" ? error?.code : undefined;
      throw new OrcaCliError(
        `${label} failed: ${message ?? result.stderrTail.trim().slice(-300)}`,
        code,
      );
    }
    return "result" in envelope ? envelope.result : parsed;
  }
}

/** Single-line, length-capped, control-free label for Orca titles/objectives (argv only). */
export function orcaLabel(text: string, max = 80): string {
  const cleaned = Array.from(text, (c) => (c.charCodeAt(0) < 0x20 || c === "\u007f" ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, max) || "matrix";
}

/** POSIX single-quote escaping: the only quoting used when Matrix writes shell text. */
export function shellQuote(value: string): string {
  if (value.includes("\u0000")) throw new Error("NUL byte in shell argument");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
