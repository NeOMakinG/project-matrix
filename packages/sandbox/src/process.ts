import { spawn } from "node:child_process";

export interface ProcessSpec {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  /** Sandboxes mount the working directory read-only (review and judge runs). */
  readOnly?: boolean;
}

export interface ProcessOutcome {
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  stderrTail: string;
}

export type LineExecutor = (
  spec: ProcessSpec,
  onLine: (line: string) => void,
  signal: AbortSignal,
) => Promise<ProcessOutcome>;

const STDERR_TAIL = 8 * 1024;

export function splitLines(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.length > 0) onLine(line);
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      const line = buffer.replace(/\r$/, "");
      buffer = "";
      if (line.length > 0) onLine(line);
    },
  };
}

/** Runs a command on the host, streaming stdout line by line. Only `env` is passed to the child. */
export const hostExecutor: LineExecutor = (spec, onLine, signal) =>
  new Promise((resolve, reject) => {
    const [command, ...args] = spec.cmd;
    if (!command) {
      reject(new Error("empty command"));
      return;
    }
    if (signal.aborted) {
      resolve({ exitCode: -1, timedOut: false, cancelled: true, stderrTail: "" });
      return;
    }
    const child = spawn(command, args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stderrTail = "";
    let timedOut = false;
    let cancelled = false;
    const lines = splitLines(onLine);
    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        if (child.exitCode === null && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }, 5000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, spec.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => lines.push(chunk));
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      lines.flush();
      resolve({ exitCode: code ?? -1, timedOut, cancelled, stderrTail });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(spec.stdin ?? "");
  });

/** Buffers a whole run; convenience for short commands. */
export async function runToCompletion(
  executor: LineExecutor,
  spec: ProcessSpec,
  signal: AbortSignal = new AbortController().signal,
): Promise<ProcessOutcome & { stdout: string }> {
  const out: string[] = [];
  const outcome = await executor(spec, (line) => out.push(line), signal);
  return { ...outcome, stdout: out.join("\n") };
}
