import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism, freemem, loadavg } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  FactoryToolingError,
  type MergePort,
  type PhaseContext,
  type Receipt,
  type Runner,
  type RunnerId,
  type Sandbox,
} from "@matrix/core";
import { graphArtifacts } from "@matrix/graph";
import { architectureGates } from "@matrix/rules";
import { createRunner } from "@matrix/runners";
import {
  CredentialBroker,
  type CredentialSource,
  LLM_PORT,
  PodmanSandbox,
  RUN_TOKEN_PLACEHOLDER,
  requiredStackTools,
  resolveCredential,
  runSecretGate,
  validateImageCapabilities,
} from "@matrix/sandbox";
import {
  NativeWorkspace,
  OrcaWorkspace,
  safeSegment,
  TrustedWorktrees,
  WorktreeGitPort,
} from "@matrix/workspace";
import type { PrivateStateOwner } from "../state-owner.js";
import { derivedGraphHandover } from "./derived-graph.js";
import type { StoredProject } from "./mapping.js";
import { gatewayModels, type ModelLister } from "./model-plan.js";
import { redactNativeDiagnostic } from "./native-diagnostics.js";
import { type OrcaRuntimeBridge, orcaBridge } from "./orca-runtime.js";
import { committedQaSnapshot } from "./qa-snapshot.js";
import type { Runtime } from "./runtime.js";
import { scenarioQaDriver } from "./scenario-qa.js";
import { scanCommittedHistory } from "./secret-scan.js";
import { scanSourceSnapshot } from "./source-scan.js";

const exec = promisify(execFile);

function assertHostCapacity(): void {
  if (freemem() < 4 * 1024 ** 3 || (loadavg()[0] ?? Infinity) >= availableParallelism())
    throw new Error("host resource check refused a heavy Matrix task");
}

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
  /** Orca runtime environment (paired remote). Omit to drive the local Orca runtime. */
  orcaEnvironment?: string;
  /** Absolute Orca IDE CLI path (default /opt/Orca/resources/bin/orca-ide; never PATH `orca`). */
  orcaBinary?: string;
  stateOwner?: PrivateStateOwner;
  /**
   * Per-project edit policy. Existing repos (registered by path) get their own editable paths and
   * keep Matrix artifacts (the derived code graph) host-side instead of committing them.
   */
  projectPolicy?: (projectId: string) => Promise<ProjectEditPolicy>;
  /** Gateway model list (default: GET <gatewayUrl>/v1/models with the gateway key). Tests inject it. */
  listModels?: ModelLister;
}

export interface ProjectEditPolicy {
  external: boolean;
  editablePaths?: string[];
}

/**
 * A Runner that builds a fresh CLI runner per run, bound to that run's broker grant: the container
 * only ever sees a per-run token, the broker swaps it for the real gateway key outside.
 */
export const NATIVE_SOURCE_PATHS = [
  "src",
  "apps",
  "packages",
  "tests",
  "test",
  "cmd",
  "internal",
  "migrations",
  "index.ts",
  "package.json",
  "bun.lock",
  "bun.lockb",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vitest.config.ts",
  "biome.json",
  "eslint.config.js",
  "go.mod",
  "go.sum",
  "sqlc.yaml",
  "sqlc.yml",
  "Cargo.toml",
  "Cargo.lock",
];

/** Executable each runner needs in the runner image (packages/sandbox/images/runner). */
export const RUNNER_BINARY: Record<RunnerId, string> = {
  codex: "codex",
  "claude-code": "claude",
  opencode: "opencode",
};

/** Runners the native/Orca runtime wires (both CLIs ship in the runner image). */
export const NATIVE_RUNNERS = ["codex", "claude-code"] as const satisfies readonly RunnerId[];

/** Gateway model list, cached briefly, used to refuse ids the gateway does not serve. */
export function servedModels(list: ModelLister, ttlMs = 60_000, now = () => Date.now()) {
  let cache: { at: number; ids: Set<string> } | undefined;
  return {
    async assert(model: string): Promise<void> {
      if (!cache || now() - cache.at > ttlMs || !cache.ids.has(model)) {
        const ids = await list().catch(() => undefined);
        if (!ids)
          throw new FactoryToolingError(
            `cannot verify model ${model}: the gateway model list (GET /v1/models) did not answer`,
          );
        cache = { at: now(), ids: new Set(ids) };
      }
      if (!cache.ids.has(model))
        throw new Error(`model ${model} is not served by the gateway (GET /v1/models)`);
    },
  };
}

function sandboxedRunner(
  id: RunnerId,
  sandbox: PodmanSandbox,
  git: WorktreeGitPort,
  opts: NativeRuntimeOptions,
  gatewayKey: () => Promise<string>,
  served: ReturnType<typeof servedModels>,
  orca?: OrcaRuntimeBridge,
): Runner {
  const local = `http://127.0.0.1:${LLM_PORT}`;
  return {
    id,
    run: async (req, onEvent, callerSignal) => {
      const signal = opts.stateOwner
        ? AbortSignal.any([callerSignal, opts.stateOwner.signal])
        : callerSignal;
      opts.stateOwner?.assertOwned();
      // Any model the gateway serves (Claude, GPT, GLM, ...); never an id it does not list.
      await served.assert(req.model);
      assertHostCapacity();
      await validateImageCapabilities(
        sandbox,
        req.workdir,
        await requiredStackTools(req.workdir, [RUNNER_BINARY[id]]),
        signal,
      );
      const expectedHead = req.phase === "implement" ? await git.headSha(req.workdir) : undefined;
      const policy: ProjectEditPolicy = (await opts.projectPolicy?.(req.projectId)) ?? {
        external: false,
      };
      const approvedPaths = policy.editablePaths?.length
        ? policy.editablePaths
        : NATIVE_SOURCE_PATHS;
      const viaOrca = orca?.phase(req);
      const ran = await createRunner(id, {
        gateway: {
          anthropicBaseUrl: local,
          openaiBaseUrl: `${local}/v1`,
          apiKey: RUN_TOKEN_PLACEHOLDER,
        },
        executor: sandbox.lineExecutor({
          runId: req.runId,
          projectId: req.projectId,
          ticketId: req.ticketId,
          network: "gateway",
          ...(viaOrca ? { launcher: viaOrca.launcher } : {}),
        }),
        skipPermissions: true,
        baseEnv: id === "codex" ? { CODEX_HOME: "/home/agent" } : {},
      }).run(
        {
          ...req,
          env: {},
          readOnly: req.phase !== "implement" || req.readOnly === true,
          prompt:
            req.phase === "implement"
              ? `${req.prompt}\n\nContainer git metadata is intentionally unavailable. Do not commit or push. Edit only approved source files: ${approvedPaths.join(", ")}. Never edit dot paths (.github, .env, .matrix).${policy.external ? "" : " Do not edit .matrix/graph: the host deterministically regenerates it before scanning and committing your source snapshot."}`
              : req.prompt,
        },
        onEvent,
        signal,
      );
      const result = viaOrca
        ? { ...ran, receipts: [...ran.receipts, ...(await viaOrca.receipts())] }
        : ran;
      if (req.phase !== "implement" || result.status !== "ok") return result;
      if (req.readOnly || signal.aborted) {
        const summary = `implementation handover refused: ${req.readOnly ? "read-only request" : "ownership or caller cancellation"}`;
        const receipt: Receipt = { kind: "log", ok: false, summary };
        return {
          ...result,
          status: "failed",
          summary,
          receipts: [...result.receipts, receipt],
        };
      }
      let secrets: string[] | undefined;
      try {
        secrets = [await gatewayKey()];
        const committed = await git.commitImplementation(req.workdir, {
          expectedHead: expectedHead as string,
          approvedPaths,
          message: `feat: Matrix ticket ${req.ticketId}`,
          signal,
          // Existing repos never get Matrix artifacts committed into their branches.
          ...(policy.external
            ? {}
            : { derivedGraph: derivedGraphHandover(req.workdir, signal, opts.stateOwner) }),
          scan: (source, binding) =>
            gatewayKey().then((key) =>
              scanSourceSnapshot(source, [key], opts.gitleaksBinary, binding),
            ),
        });
        return { ...result, receipts: [...result.receipts, committed.receipt] };
      } catch (error) {
        const reason = secrets
          ? redactNativeDiagnostic(secrets)(
              error instanceof Error ? error.message : "non-Error handover failure",
            ).slice(0, 2048)
          : "gateway credential resolution failed before handover";
        const summary = `host-mediated implementation commit refused: ${reason}`;
        const receipt: Receipt = { kind: "log", ok: false, summary };
        return {
          ...result,
          status: "failed",
          summary,
          receipts: [...result.receipts, receipt],
        };
      }
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
      const history = await scanCommittedHistory(
        repo,
        `${oldBase}..${request.headSha}`,
        opts.gitleaksBinary,
      );
      if (!history.ok) return { ok: false, summary: history.summary };
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
  const checkedSandbox: Sandbox = {
    kind: "podman",
    exec: (spec, signal) => {
      assertHostCapacity();
      return (async () => {
        const abort = signal ?? new AbortController().signal;
        try {
          await validateImageCapabilities(
            sandbox,
            spec.workdir,
            await requiredStackTools(
              spec.workdir,
              /^[a-z][a-z0-9_-]*$/.test(spec.cmd[0] ?? "") ? [spec.cmd[0] as string] : [],
            ),
            abort,
          );
        } catch (error) {
          throw new FactoryToolingError(
            `native check tooling preflight failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
        return sandbox.exec(spec, signal);
      })();
    },
  };
  const orca =
    opts.workspace === "orca"
      ? orcaBridge({
          dataDir: opts.dataDir,
          ...(opts.orcaBinary ? { binary: opts.orcaBinary } : {}),
          ...(opts.orcaEnvironment ? { environment: opts.orcaEnvironment } : {}),
        })
      : undefined;
  const workspace = orca
    ? new OrcaWorkspace({
        cli: orca.cli,
        trusted,
        beforeRemove: (w) => orca.release(w),
        stopRunners: (target) => sandbox.stop(target),
      })
    : new NativeWorkspace({
        root: join(opts.dataDir, "worktrees"),
        trusted,
        stopRunners: (target) => sandbox.stop(target),
      });
  let key: string | undefined;
  const gatewayKey = async () => (key ??= await resolveCredential(opts.gatewayKey));
  const git = new WorktreeGitPort({ trusted });
  const served = servedModels(
    opts.listModels ??
      (async () =>
        gatewayModels(
          `${opts.gatewayUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`,
          await gatewayKey(),
        )()),
  );
  const runners = Object.fromEntries(
    NATIVE_RUNNERS.map((id) => [
      id,
      sandboxedRunner(id, sandbox, git, opts, gatewayKey, served, orca),
    ]),
  ) as Partial<Record<RunnerId, Runner>>;
  return {
    kind: opts.workspace,
    broker,
    workspace,
    git,
    deps: {
      architecture: async (ctx) => {
        const all = await architectureGates(ctx.workdir, {
          rulesFrom: ctx.project.baseBranch,
        });
        const external = Boolean((ctx.project as StoredProject).matrix?.repo);
        const isDrift = (receipt: Receipt) =>
          typeof receipt.data === "object" &&
          receipt.data !== null &&
          "stale" in receipt.data &&
          Array.isArray(receipt.data.stale);
        // Existing repos keep the derived graph host-side: no in-repo drift gate for them.
        const receipts = external ? all.filter((receipt) => !isDrift(receipt)) : all;
        if (external) await keepGraphHostSide(opts.dataDir, ctx.project.id, ctx.workdir);
        if (
          receipts.some(
            (receipt) =>
              !receipt.ok &&
              typeof receipt.data === "object" &&
              receipt.data !== null &&
              "stale" in receipt.data &&
              Array.isArray(receipt.data.stale),
          )
        )
          throw new FactoryToolingError(
            "host-derived code graph is stale; factory regeneration must be repaired",
            receipts,
          );
        return [
          ...receipts,
          await scanCommittedHistory(
            ctx.project.repoPath,
            `${ctx.project.baseBranch}..${await git.headSha(ctx.workdir)}`,
            opts.gitleaksBinary,
          ),
        ];
      },
      runners,
      sandbox: checkedSandbox,
      qa: scenarioQaDriver({
        ...(opts.gitleaksBinary ? { gitleaksBinary: opts.gitleaksBinary } : {}),
        sandbox: checkedSandbox,
        runners,
        git,
        snapshot: (ctx) => committedQaSnapshot(ctx, git, trusted, opts.stateOwner),
        secrets: async () => [await gatewayKey()],
        ...(opts.stateOwner ? { owner: opts.stateOwner } : {}),
      }),
      merge: localMerge(opts, gatewayKey),
    },
  };
}

/** Writes an existing repo's derived code graph under the Matrix state dir, never into the repo. */
async function keepGraphHostSide(dataDir: string, projectId: string, workdir: string) {
  const dir = join(dataDir, "projects", safeSegment(projectId), "graph");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const { files } = await graphArtifacts(workdir);
  for (const [path, content] of Object.entries(files))
    await writeFile(join(dir, basename(path)), content, { mode: 0o600 });
}
