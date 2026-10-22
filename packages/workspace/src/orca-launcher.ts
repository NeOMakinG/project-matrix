import { accessSync, constants, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  type LineExecutor,
  type ProcessOutcome,
  type ProcessSpec,
  splitLines,
} from "@matrix/sandbox";
import { type OrcaCli, OrcaCliError, orcaLabel, record, shellQuote, str } from "./orca-cli.js";
import type { OrcaMessage, OrcaRunRef, OrcaTicketSession } from "./orca-session.js";

/** What one phase looked like in Orca; attached to the phase's evidence. */
export interface OrcaPhaseEvidence {
  run: OrcaRunRef;
  taskId: string;
  dispatchId: string;
  terminal: string;
  outcome: "succeeded" | "failed" | "timeout" | "cancelled" | "lost";
  /** Raw `orchestration worker-read --source terminal` result (bounded), or the read error. */
  workerRead: unknown;
  messages: OrcaMessage[];
}

export interface OrcaLauncherOptions {
  cli: OrcaCli;
  session: OrcaTicketSession;
  /** Host-private directory (made 0700) for per-phase runner scripts. Never inside a worktree. */
  scriptRoot: string;
  /** Short human label for the Orca task/terminal, e.g. `review · gpt-6-sol`. Not secret. */
  title: string;
  pollMs?: number;
  /** Grace after `worker_done` for the exit file to land. */
  exitGraceMs?: number;
  onEvidence?: (evidence: OrcaPhaseEvidence) => void | Promise<void>;
}

const SECRET_ENV = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STDERR_TAIL = 8 * 1024;
const MAX_WORKER_READ = 256 * 1024;

/** Absolute path for argv[0], resolved on the Matrix side (the Orca terminal PATH differs). */
export function resolveBinary(command: string, pathEnv: string): string {
  if (isAbsolute(command)) return command;
  if (command.includes("/")) throw new Error(`relative binary path refused: ${command}`);
  for (const dir of pathEnv.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`${command} not found on PATH`);
}

/**
 * The bash script an Orca terminal runs. Every interpolated value is single-quoted; the prompt
 * (untrusted ticket text) never appears here, it is fed from a 0600 stdin file. The script reports
 * its own `worker_done`, writes its exit code to a file (fallback when messages are lost) and
 * deletes itself.
 */
export function runnerScript(input: {
  spec: ProcessSpec;
  argv0: string;
  stdinFile?: string;
  outFile: string;
  errFile: string;
  rcFile: string;
  orcaBinary: string;
  environment?: string;
  taskId: string;
  dispatchId: string;
}): string {
  const q = shellQuote;
  const env = Object.entries(input.spec.env).map(([k, v]) => {
    if (!ENV_NAME.test(k)) throw new Error(`invalid env name ${JSON.stringify(k)}`);
    if (SECRET_ENV.test(k)) throw new Error(`refusing to put ${k} into an Orca runner script`);
    return q(`${k}=${v}`);
  });
  const cmd = [input.argv0, ...input.spec.cmd.slice(1)].map(q).join(" ");
  const environment = input.environment ? ` --environment ${q(input.environment)}` : "";
  return [
    "#!/usr/bin/env bash",
    "set -u",
    "umask 077",
    `trap 'rm -f -- ${q(input.stdinFile ?? "/nonexistent")} "$0"' EXIT`,
    `cd -- ${q(input.spec.cwd)} || { echo 97 > ${q(input.rcFile)}; exit 97; }`,
    `/usr/bin/env -i ${env.join(" ")} ${cmd} < ${q(input.stdinFile ?? "/dev/null")} > ${q(input.outFile)} 2> ${q(input.errFile)}`,
    "rc=$?",
    `printf '%s\\n' "$rc" > ${q(`${input.rcFile}.tmp`)} && mv -f -- ${q(`${input.rcFile}.tmp`)} ${q(input.rcFile)}`,
    'if [ "$rc" -eq 0 ]; then outcome=succeeded; else outcome=failed; fi',
    `${q(input.orcaBinary)} orchestration send --type worker_done --subject 'matrix phase finished' --task-id ${q(input.taskId)} --dispatch-id ${q(input.dispatchId)} --outcome "$outcome" --body "exit $rc"${environment} --json > /dev/null 2>&1 || true`,
    'echo "matrix phase finished: exit $rc"',
    "",
  ].join("\n");
}

async function readFrom(path: string, offset: number): Promise<{ chunk: Buffer; next: number }> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return { chunk: Buffer.alloc(0), next: offset };
  try {
    const { size } = await handle.stat();
    if (size <= offset) return { chunk: Buffer.alloc(0), next: offset };
    const length = Math.min(size - offset, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { chunk: buffer.subarray(0, bytesRead), next: offset + bytesRead };
  } finally {
    await handle.close();
  }
}

async function readExit(path: string): Promise<number | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  const value = text === undefined ? Number.NaN : Number.parseInt(text.trim(), 10);
  return Number.isInteger(value) ? value : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function id(value: unknown, key: string, what: string): string {
  const found = str(record(record(value)[key]).id);
  if (!found) throw new OrcaCliError(`orca ${what} returned no id`);
  return found;
}

interface PhaseFiles {
  script: string;
  stdin: string;
  out: string;
  err: string;
  rc: string;
}

/**
 * Streams the phase's stdout file into `onLine` until the worker reports `worker_done` (or its
 * exit file appears), the timeout passes, or the caller aborts. A stuck worker is interrupted.
 */
async function follow(
  files: PhaseFiles,
  spec: ProcessSpec,
  onLine: (line: string) => void,
  signal: AbortSignal,
  done: () => OrcaMessage | undefined,
  interrupt: () => Promise<void>,
  pollMs: number,
  exitGraceMs: number,
): Promise<ProcessOutcome & { outcome: OrcaPhaseEvidence["outcome"] }> {
  const lines = splitLines(onLine);
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  const drain = async () => {
    for (;;) {
      const { chunk, next } = await readFrom(files.out, offset);
      if (chunk.length === 0) return;
      offset = next;
      lines.push(decoder.write(chunk));
    }
  };
  const deadline = Date.now() + spec.timeoutMs;
  let doneAt: number | undefined;
  let exitCode: number | undefined;
  let stop: "timeout" | "cancelled" | undefined;
  while (exitCode === undefined) {
    await drain();
    exitCode = await readExit(files.rc);
    if (exitCode !== undefined) break;
    if (done() && doneAt === undefined) doneAt = Date.now();
    if (doneAt !== undefined && Date.now() - doneAt > exitGraceMs) break;
    if (signal.aborted) stop = "cancelled";
    else if (Date.now() >= deadline) stop = "timeout";
    if (stop) break;
    await sleep(pollMs);
  }
  if (stop) await interrupt().catch(() => undefined);
  // The exit file usually lands before worker_done is delivered: give the message a short window
  // so it is consumed (and acked) while this dispatch is still watched, and lands in evidence.
  const settle = Date.now() + Math.min(exitGraceMs, 5_000);
  while (!stop && exitCode !== undefined && !done() && Date.now() < settle && !signal.aborted)
    await sleep(pollMs);
  await drain();
  lines.push(decoder.end());
  lines.flush();
  const err = await readFile(files.err, "utf8").catch(() => "");
  const stderrTail = err.slice(-STDERR_TAIL);
  const message = done();
  const outcome: OrcaPhaseEvidence["outcome"] = stop
    ? stop
    : exitCode === undefined
      ? "lost"
      : exitCode === 0
        ? "succeeded"
        : "failed";
  return {
    exitCode: exitCode ?? (stop === "timeout" ? 124 : stop === "cancelled" ? 130 : 1),
    timedOut: stop === "timeout",
    cancelled: stop === "cancelled",
    stderrTail:
      outcome === "lost"
        ? `${stderrTail}\nOrca worker finished (${message?.payload.outcome ?? "unknown"}) without an exit file`.trim()
        : stderrTail,
    outcome,
  };
}

/**
 * A LineExecutor that runs the process inside an Orca terminal of the ticket's Run, so every agent
 * session is visible (and stoppable) in Orca desktop/mobile. Used as the Podman sandbox's
 * launcher: the container, its read-only mounts and the credential broker are unchanged.
 */
export function orcaLauncher(o: OrcaLauncherOptions): LineExecutor {
  const pollMs = o.pollMs ?? 1_000;
  return async (spec, onLine, signal): Promise<ProcessOutcome> => {
    const argv0 = resolveBinary(spec.cmd[0] ?? "", spec.env.PATH ?? process.env.PATH ?? "");
    const run = await o.session.open();
    const call = (args: string[]) => o.cli.call(args);
    const bound = async <T>(work: Promise<T>): Promise<T> => {
      try {
        return await work;
      } catch (error) {
        o.session.invalidate();
        throw error;
      }
    };
    const title = orcaLabel(o.title, 60);
    const taskId = id(
      await bound(
        call([
          "orchestration",
          "task-create",
          "--run",
          run.runId,
          "--from",
          run.coordinator,
          "--task-title",
          title,
          "--json",
        ]),
      ),
      "task",
      "task-create",
    );
    const created = record(
      await call([
        "terminal",
        "create",
        "--worktree",
        `path:${run.worktree}`,
        "--title",
        title,
        "--command",
        "bash",
        "--json",
      ]),
    );
    const terminal = str(record(created.terminal).handle);
    if (!terminal) throw new OrcaCliError("orca terminal create returned no handle");
    const messages: OrcaMessage[] = [];
    let dispatchId = "";
    let outcome: OrcaPhaseEvidence["outcome"] = "lost";
    let dir: string | undefined;
    let unwatch: (() => void) | undefined;
    try {
      dispatchId = id(
        await call([
          "orchestration",
          "dispatch",
          "--task",
          taskId,
          "--to",
          terminal,
          "--from",
          run.coordinator,
          "--run",
          run.runId,
          "--json",
        ]),
        "dispatch",
        "dispatch",
      );
      await mkdir(o.scriptRoot, { recursive: true, mode: 0o700 });
      await chmod(o.scriptRoot, 0o700);
      dir = await mkdtemp(join(o.scriptRoot, "phase-"));
      await chmod(dir, 0o700);
      const files: PhaseFiles = {
        script: join(dir, "run.sh"),
        stdin: join(dir, "stdin"),
        out: join(dir, "stdout"),
        err: join(dir, "stderr"),
        rc: join(dir, "exit"),
      };
      if (spec.stdin !== undefined) await writeFile(files.stdin, spec.stdin, { mode: 0o600 });
      const script = runnerScript({
        spec,
        argv0,
        ...(spec.stdin !== undefined ? { stdinFile: files.stdin } : {}),
        outFile: files.out,
        errFile: files.err,
        rcFile: files.rc,
        orcaBinary: o.cli.binary,
        ...(o.cli.environment ? { environment: o.cli.environment } : {}),
        taskId,
        dispatchId,
      });
      await writeFile(files.script, script, { mode: 0o600 });
      let done: OrcaMessage | undefined;
      unwatch = o.session.watch(dispatchId, {
        onMessage(message) {
          messages.push(message);
          if (message.type === "worker_done") done = message;
        },
      });
      await call([
        "terminal",
        "send",
        "--terminal",
        terminal,
        "--text",
        `bash ${shellQuote(files.script)}; exit`,
        "--enter",
        "--json",
      ]);
      const result = await follow(
        files,
        spec,
        onLine,
        signal,
        () => done,
        () =>
          call(["terminal", "send", "--terminal", terminal, "--interrupt", "--json"]).then(
            () => {},
          ),
        pollMs,
        o.exitGraceMs ?? 10_000,
      );
      outcome = result.outcome;
      const { outcome: _ignored, ...processOutcome } = result;
      return processOutcome;
    } finally {
      unwatch?.();
      let workerRead: unknown;
      if (dispatchId) {
        workerRead = await call([
          "orchestration",
          "worker-read",
          "--dispatch",
          dispatchId,
          "--source",
          "terminal",
          "--json",
        ]).catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
        if (JSON.stringify(workerRead ?? null).length > MAX_WORKER_READ)
          workerRead = { truncated: true };
      }
      await call(["terminal", "close", "--terminal", terminal, "--json"]).catch(() => undefined);
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (dispatchId)
        await Promise.resolve(
          o.onEvidence?.({ run, taskId, dispatchId, terminal, outcome, workerRead, messages }),
        ).catch(() => undefined);
    }
  };
}
