import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkPolicy, Sandbox, SandboxExecResult, SandboxExecSpec } from "@matrix/core";
import type { CredentialBroker, Grant } from "./broker.js";
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
import { hostExecutor, type LineExecutor, type ProcessSpec } from "./process.js";

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
}

export interface RunPolicy {
  runId: string;
  network: NetworkPolicy;
  allowHosts?: string[];
}

export function containerName(runId: string): string {
  return `matrix-${runId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

const DEFAULT_RESOURCES: SandboxResources = { memory: "4g", cpus: 2, pids: 512, tmpSize: "2g" };

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
  ): string[] {
    const inner = this.#o.containerWorkdir ?? "/work";
    const r = this.#resources;
    const args = [
      this.#o.podmanBinary ?? "podman",
      "run",
      "--rm",
      "-i",
      `--name=${containerName(runId)}`,
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
    return async (spec, onLine, signal) => {
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
        const lines = Object.entries(env).map(([k, v]) => {
          assertEnvName(k);
          if (/[\r\n]/.test(v)) throw new Error(`env var ${k} contains a newline`);
          return `${k}=${v}`;
        });
        await writeFile(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
        const argv = this.argv(spec, grant, envFile, policy.runId);
        return await exec(
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
    };
  }

  async exec(
    spec: SandboxExecSpec,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SandboxExecResult> {
    const runId = `exec-${randomBytes(6).toString("hex")}`;
    const out: string[] = [];
    const outcome = await this.lineExecutor({
      runId,
      network: spec.network,
      ...(spec.allowHosts ? { allowHosts: spec.allowHosts } : {}),
    })(
      { cmd: spec.cmd, cwd: spec.workdir, env: spec.env ?? {}, timeoutMs: spec.timeoutMs },
      (line) => out.push(line),
      signal,
    );
    return {
      code: outcome.timedOut ? 124 : outcome.exitCode,
      stdout: out.join("\n"),
      stderr: outcome.stderrTail,
    };
  }
}
