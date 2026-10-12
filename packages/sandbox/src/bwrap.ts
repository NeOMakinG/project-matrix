import { randomBytes } from "node:crypto";
import type { Sandbox, SandboxExecResult, SandboxExecSpec } from "@matrix/core";
import type { CredentialBroker, Grant } from "./broker.js";
import {
  assertEnvName,
  BRIDGE_ASSET,
  CONTAINER_BRIDGE,
  CONTAINER_SOCKET_DIR,
  fillRunToken,
  sandboxNetworkEnv,
  withBridge,
} from "./launch.js";
import type { RunPolicy } from "./podman.js";
import { hostExecutor, type LineExecutor, type ProcessSpec } from "./process.js";

export interface BwrapSandboxOptions {
  broker: CredentialBroker;
  bwrapBinary?: string;
  /** Host directories exposed read-only (toolchains, CLI installs). System dirs are always included. */
  readOnlyBinds?: string[];
  /** PATH inside the sandbox. */
  path?: string;
  nodeBinary?: string;
  executor?: LineExecutor;
  bridgeAsset?: string;
}

const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];

/**
 * Fallback sandbox when Podman is unavailable: fresh namespaces (no network), read-only system dirs,
 * only the worktree writable, host home not mounted.
 */
export class BwrapSandbox implements Sandbox {
  readonly kind = "bwrap" as const;
  readonly #o: BwrapSandboxOptions;

  constructor(options: BwrapSandboxOptions) {
    this.#o = options;
  }

  argv(spec: ProcessSpec, grant: Pick<Grant, "socketDir" | "network" | "token">): string[] {
    const args = [
      this.#o.bwrapBinary ?? "bwrap",
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--clearenv",
    ];
    for (const dir of SYSTEM_DIRS) args.push("--ro-bind-try", dir, dir);
    for (const dir of this.#o.readOnlyBinds ?? []) args.push("--ro-bind", dir, dir);
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/home");
    args.push(spec.readOnly ? "--ro-bind" : "--bind", spec.cwd, spec.cwd);
    const bridged = grant.network !== "none" && grant.socketDir !== undefined;
    if (bridged && grant.socketDir) {
      args.push("--bind", grant.socketDir, CONTAINER_SOCKET_DIR);
      args.push("--ro-bind", this.#o.bridgeAsset ?? BRIDGE_ASSET, CONTAINER_BRIDGE);
    }
    const env: Record<string, string> = {
      PATH: this.#o.path ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp/home",
      ...sandboxNetworkEnv(grant.network),
    };
    for (const [k, v] of Object.entries(spec.env)) {
      if (k !== "PATH" && k !== "HOME") env[k] = fillRunToken(v, grant.token);
    }
    if (bridged) env.MATRIX_RUN_TOKEN = grant.token;
    for (const [k, v] of Object.entries(env)) {
      assertEnvName(k);
      args.push("--setenv", k, v);
    }
    args.push("--chdir", spec.cwd, "--");
    args.push(...withBridge(spec.cmd, bridged, this.#o.nodeBinary ?? "node"));
    return args;
  }

  lineExecutor(policy: RunPolicy): LineExecutor {
    const exec = this.#o.executor ?? hostExecutor;
    return async (spec, onLine, signal) => {
      const grant = await this.#o.broker.grant({
        runId: policy.runId,
        network: policy.network,
        ...(policy.allowHosts ? { allowHosts: policy.allowHosts } : {}),
      });
      try {
        const argv = this.argv(spec, grant);
        await this.#o.broker.assertNoSecrets(argv);
        return await exec(
          {
            cmd: argv,
            cwd: spec.cwd,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
            ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
            timeoutMs: spec.timeoutMs,
          },
          onLine,
          signal,
        );
      } finally {
        await grant.close();
      }
    };
  }

  async exec(
    spec: SandboxExecSpec,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SandboxExecResult> {
    const out: string[] = [];
    const outcome = await this.lineExecutor({
      runId: `exec-${randomBytes(6).toString("hex")}`,
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
