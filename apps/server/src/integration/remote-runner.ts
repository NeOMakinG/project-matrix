import { randomUUID } from "node:crypto";
import {
  type Phase,
  type ProjectConfig,
  REPORT_MOUNT,
  type RunnerHostSlot,
  type Sandbox,
} from "@matrix/core";
import { hostExecutor, type LineExecutor, runToCompletion } from "@matrix/sandbox";
import { z } from "zod";
import { type OrcaCaller, runViaOrca } from "./deploy-orca.js";
import { autoLimits } from "./host-limits.js";
import type { StoredProject } from "./mapping.js";
import { type KeySource, remoteJobArgv, splitReport } from "./remote-job.js";

/**
 * Runner hosts (`MATRIX_RUNNER_HOSTS`): extra machines reached through their paired Orca
 * runtime that take implement / checks runs. They run UNSANDBOXED (no container runtime on the
 * Mac): opt-in per host via `phases`, isolated env + fresh HOME per job, the gateway key read on
 * the host itself, every result re-gated host-side (approved paths, gitleaks) before it counts.
 */
export const runnerHostsSchema = z.array(
  z
    .object({
      name: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/),
      orca: z
        .object({
          environment: z.string().regex(/^[A-Za-z0-9_.-]{1,60}$/),
          repos: z.record(
            z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
            z.string().regex(/^\/[^\0\n]{1,300}$/),
          ),
        })
        .strict(),
      cores: z.number().int().min(1).max(256),
      ramGb: z.number().min(1).max(4096),
      phases: z.array(z.enum(["implement", "checks"])).min(1),
      key: z.union([
        z
          .object({
            secrets: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
            path: z
              .string()
              .regex(/^\/[A-Za-z0-9_/-]{0,80}$/)
              .optional(),
          })
          .strict(),
        z
          .object({
            envFile: z.string().regex(/^\/[^\0\n]{1,300}$/),
            name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          })
          .strict(),
      ]),
      /** Override the size-derived light slots. */
      slots: z.number().int().min(1).max(16).optional(),
    })
    .strict(),
);
export type RunnerHost = z.output<typeof runnerHostsSchema>[number];

export function parseRunnerHosts(raw: string | undefined): RunnerHost[] {
  if (!raw?.trim()) return [];
  return runnerHostsSchema.parse(JSON.parse(raw));
}

/** Light slots from the host's size, same formula as the project host (autoLimits). */
export function hostSlots(h: RunnerHost): number {
  return (
    h.slots ?? autoLimits(h.name, { cores: h.cores, totalGb: h.ramGb, freeGb: 0 }).defaultPerHost
  );
}

export const githubOf = (project: ProjectConfig) => (project as StoredProject).matrix?.repo?.github;

export function runnerSlots(hosts: RunnerHost[]): RunnerHostSlot[] {
  return hosts.map((h) => ({
    name: h.name,
    phases: h.phases as Phase[],
    slots: hostSlots(h),
    serves: (project) => {
      const gh = githubOf(project);
      return Boolean(gh && h.orca.repos[gh]);
    },
  }));
}

const SCRATCH = /^matrix-run\/[A-Za-z0-9_-]{1,80}$/;

/** Host-side git against GitHub with gh's credential helper (never the remote name's URL). */
export async function hostGit(
  cwd: string,
  args: string[],
  opts: { stdin?: string; executor?: LineExecutor; gh?: string } = {},
): Promise<string> {
  const r = await runToCompletion(opts.executor ?? hostExecutor, {
    cmd: [
      "git",
      "-c",
      "protocol.https.allow=always",
      "-c",
      `credential.helper=!${opts.gh ?? "gh"} auth git-credential`,
      "-C",
      cwd,
      ...args,
    ],
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_TERMINAL_PROMPT: "0",
    },
    timeoutMs: 180_000,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  });
  if (r.exitCode !== 0)
    throw new Error(`git ${args[0]} failed: ${r.stderrTail.trim().slice(-300)}`);
  return r.stdout.trim();
}

export interface RemoteRunContext {
  host: RunnerHost;
  github: string;
  workdir: string;
  runId: string;
  setup: string[][];
  executor?: LineExecutor;
  orcaCli?: OrcaCaller;
  orcaBinary?: string;
  pollMs?: number;
}

export interface RemoteSpec {
  argv: string[];
  env: Record<string, string>;
  stdin?: string;
  placeholder?: string;
  timeoutMs: number;
  /** Implement: bring the remote edits back into the workdir (uncommitted). */
  collect?: boolean;
  report?: string;
  signal?: AbortSignal;
}

/**
 * One remote job: push the workdir HEAD to a scratch branch, run on the host through Orca, and
 * for implement apply the remote commit's diff back into the workdir. Scratch branches and the
 * Orca worktree are always removed.
 */
export async function runRemote(
  c: RemoteRunContext,
  spec: RemoteSpec,
): Promise<{ exitCode: number; stdout: string; output: string; trace: string[] }> {
  const id = c.runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  const inRef = `matrix-run/${id}`;
  const outRef = `matrix-run/${id}-out`;
  if (!SCRATCH.test(inRef)) throw new Error("bad run id for a scratch branch");
  const g = (args: string[], stdin?: string) =>
    hostGit(c.workdir, args, {
      ...(c.executor ? { executor: c.executor } : {}),
      ...(stdin !== undefined ? { stdin } : {}),
    });
  const target = `https://github.com/${c.github}.git`;
  if ((await g(["status", "--porcelain"])) !== "")
    throw new Error("remote run needs a clean worktree (uncommitted changes would be lost)");
  const sha = await g(["rev-parse", "HEAD"]);
  await g(["push", "--quiet", "--no-follow-tags", target, `${sha}:refs/heads/${inRef}`]);
  const cleanupRefs = [inRef, ...(spec.collect ? [outRef] : [])];
  try {
    const r = await runViaOrca(
      { environment: c.host.orca.environment, repos: c.host.orca.repos },
      remoteJobArgv({
        sha,
        setup: c.setup,
        argv: spec.argv,
        env: spec.env,
        ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
        ...(spec.placeholder ? { placeholder: spec.placeholder } : {}),
        key: c.host.key as KeySource,
        ...(spec.collect ? { pushTo: outRef } : {}),
        ...(spec.report ? { report: spec.report } : {}),
      }),
      {
        repo: c.github,
        checkout: { sha },
        timeoutMs: spec.timeoutMs,
        label: "run",
        pollMs: c.pollMs ?? 10_000,
        ...(spec.signal ? { signal: spec.signal } : {}),
        ...(c.orcaCli ? { cli: c.orcaCli } : {}),
        ...(c.orcaBinary ? { binary: c.orcaBinary } : {}),
      },
    );
    if (spec.collect && r.exitCode === 0) {
      const local = `refs/matrix-run/${id}-out`;
      await g(["fetch", "--quiet", "--no-tags", target, `+refs/heads/${outRef}:${local}`]);
      try {
        const diff = await g(["diff", "--binary", "HEAD", local]);
        if (diff) await g(["apply", "--whitespace=nowarn", "-"], `${diff}\n`);
        r.trace.push(`collected ${diff ? "changes" : "no changes"} from ${c.host.name}`);
      } finally {
        await g(["update-ref", "-d", local]).catch(() => undefined);
      }
    }
    return r;
  } finally {
    // One push per ref: deleting a ref that was never created must not keep the other alive.
    for (const ref of cleanupRefs)
      await g(["push", "--quiet", target, `:refs/heads/${ref}`]).catch(() => undefined);
  }
}

/** Remote runner support handed to the native runtime. */
export interface RemoteRunners {
  hosts: RunnerHost[];
  project: (projectId: string) => Promise<ProjectConfig | null>;
  orcaBinary?: string;
  orcaCli?: (environment: string) => OrcaCaller;
  executor?: LineExecutor;
  pollMs?: number;
}

export function setupCommands(project: ProjectConfig): string[][] {
  const steps = (project as StoredProject).matrix?.repo?.setup ?? [];
  return steps.map((s) =>
    s.cwd ? ["sh", "-c", `cd "$1" && shift && exec "$@"`, "sh", s.cwd, ...s.run] : s.run,
  );
}

/** Resolves a run's host to a remote context, or undefined when it runs on the project host. */
export async function remoteContext(
  r: RemoteRunners | undefined,
  hostName: string | undefined,
  projectId: string,
  workdir: string,
  runId: string,
): Promise<RemoteRunContext | undefined> {
  if (!r || !hostName) return undefined;
  const host = r.hosts.find((h) => h.name === hostName);
  if (!host) throw new Error(`run routed to unknown runner host ${hostName}`);
  const project = await r.project(projectId);
  const github = project ? githubOf(project) : undefined;
  if (!project || !github || !host.orca.repos[github])
    throw new Error(`runner host ${hostName} has no checkout of this project's repo`);
  // A tree with leftovers (an earlier failed attempt) cannot be shipped by commit: run it here.
  const dirty = await hostGit(workdir, ["status", "--porcelain"], {
    ...(r.executor ? { executor: r.executor } : {}),
  }).catch(() => "unknown");
  if (dirty !== "") return undefined;
  return {
    host,
    github,
    workdir,
    runId,
    setup: setupCommands(project),
    ...(r.executor ? { executor: r.executor } : {}),
    ...(r.orcaCli ? { orcaCli: r.orcaCli(host.orca.environment) } : {}),
    ...(r.orcaBinary ? { orcaBinary: r.orcaBinary } : {}),
    ...(r.pollMs !== undefined ? { pollMs: r.pollMs } : {}),
  };
}

/** LineExecutor that runs one runner CLI spec on the remote host (implement collects edits). */
export function remoteLineExecutor(
  c: RemoteRunContext,
  o: { placeholder: string; collect: boolean },
): LineExecutor {
  return async (spec, onLine, signal) => {
    const r = await runRemote(c, {
      argv: spec.cmd,
      env: spec.env,
      ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
      placeholder: o.placeholder,
      timeoutMs: spec.timeoutMs,
      collect: o.collect,
      signal,
    });
    for (const line of r.stdout.split("\n")) if (line) onLine(line);
    return {
      exitCode: r.exitCode,
      timedOut: r.exitCode === 124,
      cancelled: signal.aborted,
      stderrTail: `${r.output.slice(-6_000)}\n${r.trace.join("\n")}`.slice(-8_192),
    };
  };
}

/**
 * Sandbox wrapper: specs with a `host` (checks routed to a runner host) run there through Orca;
 * everything else goes to the local sandbox unchanged. The report mount becomes a relative file.
 */
export function remoteAwareSandbox(local: Sandbox, r: RemoteRunners | undefined): Sandbox {
  if (!r?.hosts.length) return local;
  return {
    kind: local.kind,
    async exec(spec, signal) {
      if (!spec.host || !spec.projectId) return local.exec(spec, signal);
      const c = await remoteContext(
        r,
        spec.host,
        spec.projectId,
        spec.workdir,
        `chk-${randomUUID().slice(0, 12)}`,
      );
      if (!c) return local.exec(spec, signal);
      const rel = spec.report ? `.matrix-report/${spec.report.name}` : undefined;
      const swap = (v: string) =>
        rel ? v.split(`${REPORT_MOUNT}/${spec.report!.name}`).join(rel) : v;
      const argv = spec.cmd.map(swap);
      const env = Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, swap(v)]));
      const res = await runRemote(c, {
        argv: rel ? ["sh", "-c", 'mkdir -p .matrix-report && exec "$@"', "sh", ...argv] : argv,
        env,
        timeoutMs: spec.timeoutMs,
        ...(rel ? { report: rel } : {}),
        ...(signal ? { signal } : {}),
      });
      const { stdout, report } = splitReport(res.stdout);
      const max = spec.maxOutputBytes ?? 1_000_000;
      return {
        code: res.exitCode,
        stdout: stdout.slice(-max),
        stderr: `${res.output.slice(-16_000)}\n[runner host ${c.host.name}]`,
        ...(rel
          ? {
              report:
                report && report.length <= (spec.report?.maxBytes ?? 0)
                  ? { text: report }
                  : { error: report ? "report too big" : "report missing on the runner host" },
            }
          : {}),
      };
    },
  };
}
