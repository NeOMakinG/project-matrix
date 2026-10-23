import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NetworkPolicy,
  REPORT_MOUNT,
  type Sandbox,
  type SandboxExecResult,
  type SandboxExecSpec,
  type SandboxResourceRequest,
} from "@matrix/core";
import type { CredentialBroker, Grant } from "./broker.js";
import { registerReadOnlyExecutor } from "./executor-isolation.js";
import {
  assertEnvName,
  BRIDGE_ASSET,
  CONTAINER_BRIDGE,
  CONTAINER_SOCKET_DIR,
  fillRunToken,
  mapPath,
  sandboxNetworkEnv,
  withBridge,
} from "./launch.js";
import { hostExecutor, type LineExecutor, type ProcessSpec, runToCompletion } from "./process.js";
import { readReport, reportDir } from "./report-file.js";

export interface SandboxResources {
  memory: string;
  cpus: number;
  pids: number;
  tmpSize: string;
}

export interface PodmanSandboxOptions {
  broker: CredentialBroker;
  image: string;
  podmanBinary?: string;
  containerWorkdir?: string;
  resources?: Partial<SandboxResources>;
  executor?: LineExecutor;
  bridgeAsset?: string;
  /** Extra read-only mounts as host:container pairs (toolchains, caches). */
  readOnlyMounts?: Array<{ host: string; container: string }>;
  /** Host ceiling for per-run resource requests (MATRIX_SANDBOX_MAX_CPUS / _MAX_MEMORY_GB). */
  maxResources?: SandboxResourceRequest;
}

export interface RunPolicy {
  runId: string;
  /** Labelled on the container so a lease takeover can find and stop it. */
  projectId?: string;
  ticketId?: string;
  network: NetworkPolicy;
  allowHosts?: string[];
  /**
   * Runs the `podman run` itself (e.g. inside an Orca terminal so a human can watch it). Only the
   * launch goes through it; cleanup and the container's isolation stay with this sandbox.
   */
  launcher?: LineExecutor;
  /** Container CPU/memory for this run (project per-phase setting), clamped to `maxResources`. */
  resources?: SandboxResourceRequest;
}

export function containerName(runId: string): string {
  return `matrix-${runId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

const DEFAULT_RESOURCES: SandboxResources = { memory: "4g", cpus: 2, pids: 512, tmpSize: "2g" };

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Defaults overridden by a per-run request, each value clamped to the host ceiling. Invalid
 * values (non-finite, <= 0) are ignored, so a bad request can only fall back to the default.
 */
export function effectiveResources(
  defaults: SandboxResources,
  request: SandboxResourceRequest | undefined,
  max: SandboxResourceRequest = {},
): SandboxResources {
  const clamp = (v: number, ceiling: unknown) => (positive(ceiling) ? Math.min(v, ceiling) : v);
  const out = { ...defaults };
  if (positive(request?.cpus)) out.cpus = Math.max(0.1, clamp(request.cpus, max.cpus));
  if (positive(request?.memoryGb))
    out.memory = `${Math.max(1, Math.floor(clamp(request.memoryGb, max.memoryGb)))}g`;
  return out;
}

/** One rootless Podman container per run; the worktree is the only writable host path. */
export class PodmanSandbox implements Sandbox {
  readonly kind = "podman" as const;
  readonly #o: PodmanSandboxOptions;
  readonly #resources: SandboxResources;

  constructor(options: PodmanSandboxOptions) {
    this.#o = options;
    this.#resources = { ...DEFAULT_RESOURCES, ...options.resources };
  }

  /** Pure argv builder, exported for tests and dry runs. */
  argv(
    spec: ProcessSpec,
    grant: Pick<Grant, "socketDir" | "network">,
    envFile: string,
    runId: string,
    labels: Record<string, string> = {},
  ): string[] {
    const inner = this.#o.containerWorkdir ?? "/work";
    const r = effectiveResources(this.#resources, spec.resources, this.#o.maxResources);
    const args = [
      this.#o.podmanBinary ?? "podman",
      "run",
      "--rm",
      "-i",
      `--name=${containerName(runId)}`,
      `--label=matrix.run=${runId}`,
      ...Object.entries(labels).map(([k, v]) => `--label=matrix.${k}=${v}`),
      "--network=none",
      "--userns=keep-id",
      "--cap-drop=all",
      "--security-opt=no-new-privileges",
      "--read-only",
      `--tmpfs=/tmp:rw,size=${r.tmpSize}`,
      `--tmpfs=/home/agent:rw,size=${r.tmpSize}`,
      `--memory=${r.memory}`,
      `--cpus=${r.cpus}`,
      `--pids-limit=${r.pids}`,
      `--env-file=${envFile}`,
      `--volume=${spec.cwd}:${inner}:${spec.readOnly ? "ro" : "rw"}`,
      `--workdir=${inner}`,
    ];
    for (const m of this.#o.readOnlyMounts ?? []) args.push(`--volume=${m.host}:${m.container}:ro`);
    if (spec.reportDir) args.push(`--volume=${spec.reportDir}:${REPORT_MOUNT}:rw`);
    const bridged = grant.network !== "none" && grant.socketDir !== undefined;
    if (bridged) {
      args.push(`--volume=${grant.socketDir}:${CONTAINER_SOCKET_DIR}:rw`);
      args.push(`--volume=${this.#o.bridgeAsset ?? BRIDGE_ASSET}:${CONTAINER_BRIDGE}:ro`);
    }
    args.push(this.#o.image);
    const cmd = spec.cmd.map((a) => mapPath(a, spec.cwd, inner));
    args.push(...withBridge(cmd, bridged));
    return args;
  }

  /** Env the container receives: network env + caller env with host paths mapped. */
  containerEnv(spec: ProcessSpec, network: NetworkPolicy, token: string): Record<string, string> {
    const inner = this.#o.containerWorkdir ?? "/work";
    const env: Record<string, string> = { HOME: "/home/agent", ...sandboxNetworkEnv(network) };
    for (const [k, v] of Object.entries(spec.env)) {
      if (k === "PATH" || k === "HOME" || k === "TMPDIR") continue;
      env[k] = fillRunToken(mapPath(v, spec.cwd, inner), token);
    }
    if (network !== "none") env.MATRIX_RUN_TOKEN = token;
    return env;
  }

  lineExecutor(policy: RunPolicy): LineExecutor {
    const exec = this.#o.executor ?? hostExecutor;
    return registerReadOnlyExecutor(async (spec, onLine, signal) => {
      const grant = await this.#o.broker.grant({
        runId: policy.runId,
        network: policy.network,
        ...(policy.allowHosts ? { allowHosts: policy.allowHosts } : {}),
      });
      const envDir = await mkdtemp(join(tmpdir(), "matrix-env-"));
      try {
        await chmod(envDir, 0o700);
        const envFile = join(envDir, "env");
        const env = this.containerEnv(spec, policy.network, grant.token);
        await this.#o.broker.assertNoSecrets(Object.values(env));
        const lines = Object.entries(env).map(([k, v]) => {
          assertEnvName(k);
          if (/[\r\n]/.test(v)) throw new Error(`env var ${k} contains a newline`);
          return `${k}=${v}`;
        });
        await writeFile(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
        const labels: Record<string, string> = {};
        if (policy.projectId) labels.project = policy.projectId;
        if (policy.ticketId) labels.ticket = policy.ticketId;
        const sized =
          policy.resources && !spec.resources ? { ...spec, resources: policy.resources } : spec;
        const argv = this.argv(sized, grant, envFile, policy.runId, labels);
        await this.#o.broker.assertNoSecrets(argv);
        return await (policy.launcher ?? exec)(
          {
            cmd: argv,
            cwd: spec.cwd,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
            ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
            timeoutMs: spec.timeoutMs,
          },
          onLine,
          signal,
        );
      } finally {
        // A killed client can leave the container behind; remove it by its deterministic name.
        await exec(
          {
            cmd: [
              this.#o.podmanBinary ?? "podman",
              "rm",
              "-f",
              "--ignore",
              containerName(policy.runId),
            ],
            cwd: spec.cwd,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
            timeoutMs: 30_000,
          },
          () => {},
          new AbortController().signal,
        ).catch(() => undefined);
        await rm(envDir, { recursive: true, force: true });
        await grant.close();
      }
    });
  }

  /**
   * Lease takeover: kills and removes every container matching the filter and waits until they are
   * gone, so a new owner never shares a worktree with a still-running old runner.
   */
  async stop(filter: { runId?: string; projectId?: string; ticketId?: string }): Promise<number> {
    const labels = [
      filter.runId && `matrix.run=${filter.runId}`,
      filter.projectId && `matrix.project=${filter.projectId}`,
      filter.ticketId && `matrix.ticket=${filter.ticketId}`,
    ].filter((l): l is string => Boolean(l));
    if (labels.length === 0) throw new Error("refusing to stop containers without a filter");
    const exec = this.#o.executor ?? hostExecutor;
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };
    const podman = this.#o.podmanBinary ?? "podman";
    const list = await runToCompletion(exec, {
      cmd: [podman, "ps", "-a", "-q", ...labels.flatMap((l) => ["--filter", `label=${l}`])],
      cwd: tmpdir(),
      env,
      timeoutMs: 30_000,
    });
    const ids = list.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (ids.length === 0) return 0;
    const removed = await runToCompletion(exec, {
      cmd: [podman, "rm", "-f", "-t", "10", ...ids],
      cwd: tmpdir(),
      env,
      timeoutMs: 120_000,
    });
    if (removed.exitCode !== 0)
      throw new Error(`podman rm failed: ${removed.stderrTail.trim().slice(-300)}`);
    return ids.length;
  }

  async exec(
    spec: SandboxExecSpec,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SandboxExecResult> {
    const report = spec.report ? await reportDir(spec.report.name) : undefined;
    try {
      const out: string[] = [];
      let bytes = 0;
      let exceeded = false;
      const outcome = await this.lineExecutor({
        runId: `exec-${randomBytes(6).toString("hex")}`,
        network: spec.network,
        ...(spec.allowHosts ? { allowHosts: spec.allowHosts } : {}),
      })(
        {
          cmd: spec.cmd,
          cwd: spec.workdir,
          env: spec.env ?? {},
          timeoutMs: spec.timeoutMs,
          ...(spec.readOnly === undefined ? {} : { readOnly: spec.readOnly }),
          ...(spec.resources ? { resources: spec.resources } : {}),
          ...(report ? { reportDir: report.dir } : {}),
        },
        (line) => {
          const size = Buffer.byteLength(line) + 1;
          const over = spec.maxOutputBytes !== undefined && bytes + size > spec.maxOutputBytes;
          if (exceeded || over) {
            exceeded = true;
            return;
          }
          bytes += size;
          out.push(line);
        },
        signal,
      );
      return {
        code: outcome.timedOut ? 124 : outcome.exitCode,
        stdout: exceeded ? "[output exceeded capture limit; suppressed]" : out.join("\n"),
        stderr:
          spec.maxOutputBytes !== undefined && Buffer.byteLength(outcome.stderrTail) >= 8 * 1024
            ? "[stderr exceeded capture limit; suppressed]"
            : outcome.stderrTail,
        // Read only after the container is gone (lineExecutor removes it before returning).
        ...(report && spec.report
          ? { report: await readReport(report.dir, spec.report.name, spec.report.maxBytes) }
          : {}),
      };
    } finally {
      await report?.cleanup();
    }
  }
}
