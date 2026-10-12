import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MergePort, PhaseContext, QaDriver, Receipt, Runner, RunnerId } from "@matrix/core";
import { createRunner } from "@matrix/runners";
import {
  CredentialBroker,
  type CredentialSource,
  LLM_PORT,
  PodmanSandbox,
  RUN_TOKEN_PLACEHOLDER,
  resolveCredential,
  runSecretGate,
} from "@matrix/sandbox";
import {
  NativeWorkspace,
  OrcaWorkspace,
  TrustedWorktrees,
  WorktreeGitPort,
} from "@matrix/workspace";
import type { Runtime } from "./runtime.js";

const exec = promisify(execFile);

export interface NativeRuntimeOptions {
  workspace: "native" | "orca";
  dataDir: string;
  /** Gateway the broker forwards to (CLIProxyAPI). The key never enters a container. */
  gatewayUrl: string;
  gatewayKey: CredentialSource;
  /** Runner container image (packages/sandbox/images/runner). */
  image: string;
  podmanBinary?: string;
  gitleaksBinary?: string;
  /** Orca runtime environment (e.g. the bosgame `orca serve` pairing). */
  orcaEnvironment?: string;
}

/**
 * A Runner that builds a fresh CLI runner per run, bound to that run's broker grant: the container
 * only ever sees a per-run token, the broker swaps it for the real gateway key outside.
 */
function sandboxedRunner(id: RunnerId, sandbox: PodmanSandbox): Runner {
  const local = `http://127.0.0.1:${LLM_PORT}`;
  return {
    id,
    run: (req, onEvent, signal) =>
      createRunner(id, {
        gateway: {
          anthropicBaseUrl: local,
          openaiBaseUrl: `${local}/v1`,
          apiKey: RUN_TOKEN_PLACEHOLDER,
        },
        executor: sandbox.lineExecutor({ runId: req.runId, network: "gateway" }),
        skipPermissions: true,
        baseEnv: {},
      }).run(req, onEvent, signal),
  };
}

/** QA receipts from the project's own check commands, run in the sandbox with no network. */
function sandboxQa(sandbox: PodmanSandbox): QaDriver {
  return {
    async run(ctx: PhaseContext): Promise<Receipt[]> {
      const receipts: Receipt[] = [];
      for (const check of ctx.project.checks) {
        const result = await sandbox.exec(
          { workdir: ctx.workdir, cmd: check.cmd, network: "none", timeoutMs: 15 * 60_000 },
          ctx.signal,
        );
        receipts.push({
          kind: check.kind === "adr-check" ? "adr-check" : check.kind === "lint" ? "lint" : "test",
          ok: result.code === 0,
          summary: `${check.cmd.join(" ")} → exit ${result.code}`,
          data: { tail: result.stdout.split("\n").slice(-20).join("\n") },
        });
      }
      return receipts;
    },
  };
}

/**
 * Local merge: fast-forwards the base branch of the canonical repo to the approved head, after the
 * secret gate scanned exactly the commits being merged. Never touches a working tree; the ref update
 * is compare-and-swap so a concurrent change to the base branch fails the merge instead of losing work.
 */
function localMerge(opts: NativeRuntimeOptions, gatewayKey: () => Promise<string>): MergePort {
  return {
    async merge(ctx, request) {
      const repo = ctx.project.repoPath;
      const base = ctx.project.baseBranch;
      const git = (...args: string[]) =>
        exec("git", ["-C", repo, ...args]).then((r) => r.stdout.trim());
      const auth = await ctx.authorize("merge");
      if (!auth.ok) return { ok: false, summary: `not authorized: ${auth.reason}` };
      if (auth.headSha !== request.headSha) {
        return { ok: false, summary: "approved head and requested head differ; refusing to merge" };
      }
      const oldBase = await git("rev-parse", `refs/heads/${base}`);
      try {
        await git("merge-base", "--is-ancestor", oldBase, request.headSha);
      } catch {
        return {
          ok: false,
          summary: `${base} moved; the approved head no longer fast-forwards it`,
        };
      }
      const gate = await runSecretGate({
        gitDir: join(repo, ".git"),
        revs: [`${oldBase}..${request.headSha}`],
        secretValues: [{ name: "gateway", value: await gatewayKey() }],
        ...(opts.gitleaksBinary ? { gitleaksBinary: opts.gitleaksBinary } : {}),
      });
      if (!gate.ok) {
        return {
          ok: false,
          summary: `secret gate blocked the merge: ${gate.findings.map((f) => `${f.rule}@${f.location}`).join(", ")}`,
        };
      }
      if (!(await ctx.stillOwner()))
        return { ok: false, summary: "lost the workflow lease before merging" };
      await git("update-ref", `refs/heads/${base}`, request.headSha, oldBase);
      return {
        ok: true,
        summary: `fast-forwarded ${base} to ${request.headSha.slice(0, 12)}`,
        mergedSha: request.headSha,
      };
    },
  };
}

export function nativeRuntime(opts: NativeRuntimeOptions): Runtime & { broker: CredentialBroker } {
  const broker = new CredentialBroker({ gatewayUrl: opts.gatewayUrl, gatewayKey: opts.gatewayKey });
  const sandbox = new PodmanSandbox({
    broker,
    image: opts.image,
    resources: { memory: "4g", cpus: 2 },
    ...(opts.podmanBinary ? { podmanBinary: opts.podmanBinary } : {}),
  });
  const trusted = new TrustedWorktrees(join(opts.dataDir, "worktrees.json"));
  const workspace =
    opts.workspace === "orca"
      ? new OrcaWorkspace({
          trusted,
          ...(opts.orcaEnvironment ? { environment: opts.orcaEnvironment } : {}),
        })
      : new NativeWorkspace({
          root: join(opts.dataDir, "worktrees"),
          trusted,
          stopRunners: (target) => sandbox.stop(target),
        });
  let key: string | undefined;
  const gatewayKey = async () => (key ??= await resolveCredential(opts.gatewayKey));
  return {
    kind: opts.workspace,
    broker,
    workspace,
    git: new WorktreeGitPort({ trusted }),
    deps: {
      runners: {
        "claude-code": sandboxedRunner("claude-code", sandbox),
        codex: sandboxedRunner("codex", sandbox),
        opencode: sandboxedRunner("opencode", sandbox),
      },
      sandbox,
      qa: sandboxQa(sandbox),
      merge: localMerge(opts, gatewayKey),
    },
  };
}
