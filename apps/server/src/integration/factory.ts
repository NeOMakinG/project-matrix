import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createCompoundHandler } from "@matrix/compound";
import type { QuotaConfig } from "@matrix/config";
import {
  type AgentQaPort,
  createDefaultHandlers,
  EventBus,
  MemoryStore,
  PgStore,
  type ProjectConfig,
  Reconciler,
  type Store,
} from "@matrix/core";
import { GatewayLlm, type LlmClient } from "@matrix/monitor";
import type { TicketStore } from "@matrix/tickets";
import { BeadsQueueTimeoutError, withBeadsQueue } from "@matrix/tickets/adapters/beads-queue";
import { fileProposals, runWatch, SeenStore } from "@matrix/watch";
import { OrcaWorkspace } from "@matrix/workspace";
import { PrivateState } from "../private-state.js";
import { PrivateStateOwner } from "../state-owner.js";
import { createSurfaceLanes } from "./agent-qa-surfaces.js";
import { setRouteOwner } from "./deploy-orca.js";
import type { DeployHost } from "./deploy-plan.js";
import { deployPort, verifyPort } from "./deploy-stage.js";
import { externalAwareMerge, GitHubPullRequests } from "./github-pr.js";
import { autoLimits } from "./host-limits.js";
import { repoKnowledge } from "./knowledge.js";
import type { StoredProject } from "./mapping.js";
import { gatewayModels } from "./model-plan.js";
import { fakeTriageLlm, ServerMonitor } from "./monitor.js";
import type { NativeRuntimeOptions } from "./native-runtime.js";
import { reapRouteWorktrees } from "./orca-reaper.js";
import { publishOwnedFile } from "./owned-files.js";
import { OwnedHoldoutStore } from "./owned-holdout.js";
import { ownedExternalTickets } from "./owned-tickets.js";
import { resolveQuota } from "./quota-config.js";
import { RealCore } from "./real-core.js";
import { type RunnerHost, runnerSlots } from "./remote-runner.js";
import { createRuntime, type RuntimeKind } from "./runtime.js";
import { scanCommittedHistory } from "./secret-scan.js";
import { CLEANUP_STATUSES, TicketCleanup } from "./ticket-cleanup.js";
import {
  type TicketBinaries,
  type TicketSettings,
  TrackerTimeoutError,
  trackerDeadline,
} from "./tickets.js";
import { TrackerUnavailableError } from "./tracker-error.js";
import { TrackerHealth } from "./tracker-health.js";
import { TrackerSync } from "./tracker-sync.js";

export interface FactoryOptions {
  stateOwner?: PrivateStateOwner;
  runtime: RuntimeKind;
  /** Required for the native and orca runtimes. */
  native?: Omit<NativeRuntimeOptions, "workspace" | "dataDir">;
  /** Postgres URL; without it the factory runs on the in-memory store (dev and tests only). */
  databaseUrl?: string;
  dataDir: string;
  host: string;
  /** Deploy capability map (`MATRIX_DEPLOY_HOSTS`). */
  deployHosts?: DeployHost[];
  /** Runner hosts (MATRIX_RUNNER_HOSTS): implement / checks runs off this host, via Orca. */
  runnerHosts?: RunnerHost[];
  /** Deck note before coordinated deploys (EagleRay activity log). */
  deckNote?: (summary: string) => Promise<void>;
  /** Run concurrency per host (`MATRIX_LIMITS`); defaults keep one heavy run per host. */
  limits?: Partial<import("@matrix/core").Limits>;
  /** OpenAI-compatible gateway for triage; required unless the runtime is fake. */
  gateway?: { baseUrl: string; apiKey: string };
  triageModel?: string;
  /** Subscription quota guard (`MATRIX_QUOTA`); defaults apply to native/orca runtimes. */
  quota?: QuotaConfig;
  tickMs?: number;
  monitorMs?: number;
  /** Weekly tech watch over every project (network access). */
  watch?: boolean;
  log?: (message: string) => void;
  binaries?: TicketBinaries;
  /** `MATRIX_REPO_ROOTS`: directories existing repos may be registered from (empty = off). */
  repoRoots?: string[];
  /** Merged/closed-PR cleanup sweep interval (`MATRIX_CLEANUP_MS`); 0 disables. Default 15 min. */
  cleanupMs?: number;
  /** `MATRIX_CLEANUP_DRY_RUN=1`: the sweep logs what it would remove and changes nothing. */
  cleanupDryRun?: boolean;
  /** Test seam: replaces the GitHub draft-PR publisher. */
  pullRequests?: GitHubPullRequests;
  /** `MATRIX_QA_LANE_CONFIG`: device-host agent QA lane settings (qa.driver "agent" projects). */
  agentQaLaneConfig?: string;
  /** Test seam: replaces the agent QA lane. */
  agentQa?: AgentQaPort;
}

const run = promisify(execFile);

/**
 * New project repo: `git init` on `main` with one commit (worktrees need a base), and the beads
 * database when beads is the tracker (stealth: kept out of commits).
 */
export async function initProjectRepo(
  repoPath: string,
  tickets: TicketSettings,
  binaries: TicketBinaries = {},
  owner?: PrivateStateOwner,
): Promise<void> {
  const execute = async (
    binary: string,
    args: string[],
    options: { cwd?: string; signal?: AbortSignal } = {},
  ) => {
    owner?.assertOwned();
    const signal =
      options.signal && owner
        ? AbortSignal.any([options.signal, owner.signal])
        : (options.signal ?? owner?.signal);
    const result = await run(binary, args, { ...options, signal, killSignal: "SIGKILL" });
    owner?.assertOwned();
    return result;
  };
  const git = (...args: string[]) => execute("git", ["-C", repoPath, ...args]);
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Project Matrix");
  await git("config", "user.email", "matrix@localhost");
  await git("commit", "--allow-empty", "-q", "-m", "chore: initial commit");
  if (tickets.kind === "beads") {
    try {
      await withBeadsQueue(
        repoPath,
        () =>
          trackerDeadline(
            (signal) =>
              execute(
                binaries.bd ?? "bd",
                ["init", "--non-interactive", "--quiet", "--stealth", "--prefix", "mx"],
                { cwd: repoPath, signal },
              ),
            owner?.signal,
          ),
        owner?.signal,
      );
    } catch (error) {
      owner?.assertOwned();
      throw new TrackerUnavailableError(
        error instanceof TrackerTimeoutError || error instanceof BeadsQueueTimeoutError
          ? "timeout"
          : error && typeof error === "object" && "code" in error && error.code === "ENOENT"
            ? "missing"
            : "failed",
      );
    }
  }
}

/** A TicketStore whose backing adapter is resolved per call (the reconciler needs it synchronously). */
export function lazyTickets(resolve: () => Promise<TicketStore>): TicketStore {
  const call =
    <K extends keyof TicketStore>(key: K) =>
    async (...args: unknown[]) => {
      const store = await resolve();
      return (store[key] as (...a: unknown[]) => unknown)(...args);
    };
  return {
    kind: "markdown",
    list: call("list"),
    get: call("get"),
    create: call("create"),
    update: call("update"),
    comment: call("comment"),
    link: call("link"),
    ready: call("ready"),
    // Optional capabilities: forwarded when the resolved store has them, otherwise no-ops.
    addLabel: async (id: string, label: string) => (await resolve()).addLabel?.(id, label),
    removeLabel: async (id: string, label: string) => (await resolve()).removeLabel?.(id, label),
    listComments: async (id: string) => (await (await resolve()).listComments?.(id)) ?? [],
    // Agent QA screenshots. A store without uploads answers "" (not a URL): the report lists the
    // file names, with no per-screenshot tracker failure.
    uploadFile: async (id: string, name: string, contentType: string, bytes: Uint8Array) =>
      (await (await resolve()).uploadFile?.(id, name, contentType, bytes)) ?? "",
  } as TicketStore;
}

async function createOwnedFactory(
  options: FactoryOptions,
  stateOwner: PrivateStateOwner,
  ownsOwnership: boolean,
) {
  const log = options.log ?? ((m: string) => console.log(m));
  const runtime = createRuntime(
    options.runtime,
    options.native
      ? {
          ...options.native,
          dataDir: options.dataDir,
          stateOwner,
          ...(options.runnerHosts?.length
            ? {
                remote: {
                  hosts: options.runnerHosts,
                  project: (projectId: string) => store.getProject(projectId),
                  // Scratch pushes publish handed-over commits only; scanned again before.
                  scan: (workdir: string, sha: string, project: ProjectConfig) =>
                    scanCommittedHistory(
                      workdir,
                      `${project.baseBranch}..${sha}`,
                      options.native?.gitleaksBinary,
                    ),
                  ...(options.native.orcaBinary ? { orcaBinary: options.native.orcaBinary } : {}),
                },
              }
            : {}),
          // Resolved per run (the store exists by then): existing repos' edit policy.
          projectPolicy: async (projectId: string) => {
            const project = (await store.getProject(projectId)) as StoredProject | null;
            const repo = project?.matrix?.repo;
            return repo
              ? {
                  external: true,
                  ...(repo.editablePaths ? { editablePaths: repo.editablePaths } : {}),
                }
              : { external: false };
          },
        }
      : undefined,
  );
  mkdirSync(join(options.dataDir, "projects"), { recursive: true, mode: 0o700 });
  mkdirSync(join(options.dataDir, "holdout"), { recursive: true, mode: 0o700 });

  const rawStore: Store & { close?: () => Promise<void> } = options.databaseUrl
    ? await PgStore.connect(options.databaseUrl, {
        migrate: true,
        assertOwned: () => stateOwner.assertOwned(),
        signal: stateOwner.signal,
      })
    : new MemoryStore();
  const store = stateOwner.fence(rawStore);
  const bus = new EventBus();
  const holdout = new OwnedHoldoutStore(join(options.dataDir, "holdout"), stateOwner);
  // Existing repos end with a pushed branch + draft PR (host-side gh); greenfield merges locally.
  const pullRequests =
    options.pullRequests ??
    new GitHubPullRequests({
      stateFile: join(options.dataDir, "pull-requests.json"),
      stateOwner,
      ...(options.binaries?.gh ? { ghBinary: options.binaries.gh } : {}),
      ...(options.runtime === "fake"
        ? {}
        : {
            scan: (repo: string, range: string) =>
              scanCommittedHistory(repo, range, options.native?.gitleaksBinary),
          }),
    });
  const agentQa =
    options.agentQa ??
    (options.agentQaLaneConfig
      ? createSurfaceLanes(options.agentQaLaneConfig, `matrix-server@${hostname()}`)
      : undefined);
  const deployStage = {
    prs: pullRequests,
    hosts: options.deployHosts ?? [],
    ...(options.deckNote ? { deckNote: options.deckNote } : {}),
    ...(options.native?.orcaBinary ? { orca: { binary: options.native.orcaBinary } } : {}),
  };
  const deploy = deployPort(deployStage);
  const verify = verifyPort(deployStage);
  const handlers = {
    ...createDefaultHandlers({
      ...runtime.deps,
      store,
      holdout,
      merge: externalAwareMerge(pullRequests, runtime.deps.merge),
      deploy: {
        deploy: (ctx, req) =>
          ctx.project.deploy
            ? deploy.deploy(ctx, req)
            : (runtime.deps.deploy?.deploy(ctx, req) ??
              Promise.resolve({ ok: false, summary: "no deploy port configured" })),
      },
      verify: {
        verify: (ctx) =>
          ctx.project.deploy
            ? verify.verify(ctx)
            : (runtime.deps.verify?.verify(ctx) ?? Promise.resolve([])),
      },
    }),
    compound: createCompoundHandler({
      store,
      publish: async (root, path, content) => {
        publishOwnedFile({ root, path, content, replace: true, owner: stateOwner });
      },
    }),
  };

  let core: RealCore | undefined;
  const tickets = (projectId: string) =>
    stateOwner.fence(
      lazyTickets(async () => {
        if (!core) throw new Error("factory not ready");
        return core.ticketStore(projectId);
      }),
    );

  const reconciler = new Reconciler({
    store,
    bus,
    handlers,
    workspace: stateOwner.fence(runtime.workspace),
    git: stateOwner.fence(runtime.git),
    tickets,
    projectDispatchAllowed: (projectId) => core?.projectDispatchAllowed(projectId) ?? false,
    withTicketSnapshotLock: (projectId, operation) => {
      if (!core) throw new Error("factory not ready");
      return core.withTicketSnapshotLock(projectId, operation);
    },
    limits:
      options.runtime === "fake"
        ? { perProject: 4, perModel: {}, defaultPerModel: 4, perHost: {}, defaultPerHost: 8 }
        : { ...autoLimits(options.host), ...options.limits },
    backoff: { baseMs: 5_000, maxMs: 10 * 60_000 },
    // The fake runtime has no subscription to protect; real runtimes always get the guard.
    ...(options.runtime === "fake" && !options.quota ? {} : resolveQuota(options.quota)),
    ...(runtime.gatewayReady ? { gatewayReady: runtime.gatewayReady } : {}),
    host: options.host,
    ...(options.runnerHosts?.length && options.runtime !== "fake"
      ? { runnerHosts: runnerSlots(options.runnerHosts) }
      : {}),
    scratchRoot: join(options.dataDir, "scratch"),
    pullRequests: stateOwner.fence(pullRequests),
    ...(agentQa ? { agentQa } : {}),
  });

  const llm: LlmClient =
    options.runtime === "fake" && !options.gateway
      ? fakeTriageLlm
      : (() => {
          if (!options.gateway)
            throw new Error("MATRIX_GATEWAY_URL and MATRIX_GATEWAY_KEY are required");
          return new GatewayLlm({ ...options.gateway, signal: stateOwner.signal });
        })();

  const monitor = new ServerMonitor({
    stateOwner,
    dataDir: options.dataDir,
    repoPath: async (projectId) => {
      const project = await store.getProject(projectId);
      if (!project) throw new Error("monitor project not found");
      return project.repoPath;
    },
    trackerVisibility: async (projectId) => {
      const project = await store.getProject(projectId);
      const settings = (project as import("./mapping.js").StoredProject | null)?.matrix?.tickets;
      return settings?.kind === "github" ? "public" : "private";
    },
    llm,
    model: options.triageModel ?? "gpt-6.1-sol",
    tickets: async (projectId) => {
      if (!core) throw new Error("factory not ready");
      return ownedExternalTickets(
        await core.ticketStore(projectId),
        stateOwner,
        join(options.dataDir, "projects", `${projectId}.monitor-tickets.json`),
      );
    },
    projectIds: async () => (await store.listProjects()).map((p) => p.id),
  });

  // Quota cooldowns are operational signals: tickets wait, so make the reason visible in logs.
  bus.subscribe((event) => {
    if (event.type === "quota.cooldown")
      log(JSON.stringify({ level: "warn", ...event, reason: event.reason.slice(0, 200) }));
  });
  const trackerHealth = new TrackerHealth(bus, log);
  trackerHealth.start();
  const trackerSync = new TrackerSync({
    bus,
    tickets: async (projectId) => {
      if (!core) throw new Error("factory not ready");
      return core.ticketStore(projectId);
    },
  });
  trackerSync.start();

  core = new RealCore({
    stateOwner,
    trackerHealth,
    fakeRuntime: options.runtime === "fake",
    stateFile: join(options.dataDir, "core-state.json"),
    store,
    bus,
    reconciler,
    projectsRoot: join(options.dataDir, "projects"),
    host: options.host,
    knowledge: repoKnowledge,
    monitor,
    initRepo: (repoPath, tickets) =>
      initProjectRepo(repoPath, tickets, options.binaries, stateOwner),
    repoRoots: options.repoRoots ?? [],
    ...(runtime.workspace instanceof OrcaWorkspace
      ? {
          verifyRepo: async (path: string) => {
            await (runtime.workspace as OrcaWorkspace).ensureRepo(path);
          },
        }
      : {}),
    ...(options.gateway
      ? { listModels: gatewayModels(options.gateway.baseUrl, options.gateway.apiKey) }
      : {}),
    ...(options.binaries ? { binaries: options.binaries } : {}),
  });

  const ticketCleanup = runtime.cleanup
    ? new TicketCleanup({
        ...runtime.cleanup,
        workflows: () => store.listWorkflows({ status: [...CLEANUP_STATUSES] }),
        getWorkflow: (projectId, ticketId) => store.getWorkflow(projectId, ticketId),
        clearWorkdir: async (w) => {
          try {
            const { workdir: _w, workspaceRef: _r, ...rest } = w;
            await store.saveWorkflow(rest);
            return true;
          } catch {
            return false;
          }
        },
        prState: (projectId, ticketId) => pullRequests.prState(projectId, ticketId),
        log,
      })
    : undefined;

  const timers: ReturnType<typeof setInterval>[] = [];
  const activeLoops = new Map<string, Promise<unknown>>();
  const watchState = new PrivateState<{ nextAt: number }>(
    join(options.dataDir, "watch-schedule.json"),
    stateOwner,
  );
  const watchSchedule = watchState.load({ nextAt: 0 });
  const loop = {
    lastTickAt: undefined as string | undefined,
    lastError: undefined as string | undefined,
  };
  const halt = () => {
    trackerSync.stop();
    trackerHealth.stop();
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
    reconciler.stop();
  };
  stateOwner.signal.addEventListener("abort", halt, { once: true });
  const guarded = (name: string, fn: () => Promise<unknown>) => async () => {
    if (activeLoops.has(name)) return;
    const pending = Promise.resolve().then(() => {
      stateOwner.assertOwned();
      return stateOwner.guard(fn);
    });
    activeLoops.set(name, pending);
    try {
      await pending;
    } catch (error) {
      log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      activeLoops.delete(name);
    }
  };

  const watchAll = async () => {
    if (Date.now() < watchSchedule.nextAt) return;
    for (const project of await store.listProjects()) {
      // The watch writes digests into the repo: never into an operator's existing checkout.
      if ((project as import("./mapping.js").StoredProject).matrix?.repo) continue;
      const result = await stateOwner.guard(() =>
        runWatch({
          root: project.repoPath,
          dryRun: true,
          http: { signal: stateOwner.signal },
          ...(options.gateway
            ? {
                gateway: {
                  baseUrl: options.gateway.baseUrl,
                  apiKey: options.gateway.apiKey,
                  model: options.triageModel ?? "gpt-6.1-sol",
                  signal: stateOwner.signal,
                },
              }
            : {}),
        }),
      );
      if (result.errors.length)
        throw new Error(
          `watch had ${result.errors.length} collection errors; retrying before checkpoint`,
        );
      stateOwner.assertOwned();
      publishOwnedFile({
        root: project.repoPath,
        path: join(project.repoPath, ".matrix", "watch", `digest-${result.week}.md`),
        content: result.digest,
        replace: true,
        owner: stateOwner,
      });
      const tracker = ownedExternalTickets(
        await (core as RealCore).ticketStore(project.id),
        stateOwner,
        join(options.dataDir, "projects", `${project.id}.watch-tickets.json`),
      );
      result.tickets = await fileProposals(tracker, result.scored, 0.5);
      const seenStore = new SeenStore(project.repoPath);
      const seen = await stateOwner.guard(() => seenStore.load());
      for (const item of result.scored) seen.add(item.id);
      publishOwnedFile({
        root: project.repoPath,
        path: seenStore.path,
        content: `${JSON.stringify([...seen].sort())}\n`,
        replace: true,
        owner: stateOwner,
      });
      log(
        `watch ${project.id}: ${result.relevant.length} relevant, ${result.tickets.length} tickets`,
      );
    }
    watchSchedule.nextAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    watchState.save(watchSchedule);
  };

  return {
    stateOwner,
    core,
    store,
    trackerSync,
    trackerHealth,
    bus,
    reconciler,
    monitor,
    runtime: runtime.kind,
    /** Health for /healthz: store reachable, runtime kind, reconcile loop state. */
    async health() {
      await store.listProjects();
      return {
        runtime: runtime.kind,
        store: options.databaseUrl ? "postgres" : "memory",
        lastTickAt: loop.lastTickAt ?? null,
        ...(loop.lastError ? { ok: false, lastError: loop.lastError } : {}),
      };
    },
    /** Starts the reconcile, monitor and (optional) weekly watch loops. */
    start() {
      stateOwner.assertOwned();
      if (timers.length) return;
      const tick = async () => {
        try {
          await reconciler.tick();
          loop.lastTickAt = new Date().toISOString();
          loop.lastError = undefined;
        } catch (error) {
          loop.lastError = error instanceof Error ? error.message : String(error);
          log(`reconcile failed: ${loop.lastError}`);
        }
      };
      const monitorTick = guarded("monitor", () => monitor.tick());
      timers.push(setInterval(guarded("reconcile", tick), options.tickMs ?? 5_000));
      timers.push(setInterval(monitorTick, options.monitorMs ?? 30_000));
      if (options.watch) {
        const watchTick = guarded("watch", watchAll);
        timers.push(setInterval(watchTick, 60 * 60 * 1000));
        void watchTick();
      }
      const cleanupMs = options.cleanupMs ?? 15 * 60_000;
      if (ticketCleanup && cleanupMs > 0) {
        const sweep = guarded("ticket-cleanup", () =>
          ticketCleanup.sweep({ dryRun: options.cleanupDryRun === true }),
        );
        timers.push(setInterval(sweep, cleanupMs));
        // One-shot sweep for tickets whose PR was merged/closed while the server was down.
        const first = setTimeout(sweep, 60_000);
        first.unref?.();
      }
      // Orca route leftovers (restart or crash mid-run): removed after 30 min with no live run.
      const routes = [
        ...(options.runnerHosts ?? []).map((h) => h.orca),
        ...(options.deployHosts ?? []).flatMap((h) => (h.orca ? [h.orca] : [])),
      ];
      // The state-owner lease is exclusive per data dir, so host + data dir names exactly one
      // live server: only its own route worktrees are ever reaped.
      setRouteOwner(
        `${options.host.slice(0, 40)}:${createHash("sha256")
          .update(`${options.host}\u0000${resolve(options.dataDir)}`)
          .digest("hex")
          .slice(0, 16)}`,
      );
      if (routes.length && options.runtime !== "fake") {
        const reap = guarded("orca-reaper", async () => {
          const r = await reapRouteWorktrees({
            routes,
            ...(options.native?.orcaBinary ? { binary: options.native.orcaBinary } : {}),
          });
          if (r.removed.length || r.errors.length)
            log(
              `orca-reaper: removed ${r.removed.join(", ") || "none"}${r.errors.length ? `; errors: ${r.errors.join("; ")}` : ""}`,
            );
        });
        timers.push(setInterval(reap, 10 * 60_000));
        const firstReap = setTimeout(reap, 60_000);
        firstReap.unref?.();
      }
      for (const t of timers) t.unref?.();
    },
    async stop() {
      halt();
      if (!stateOwner.signal.aborted) {
        await stateOwner
          .guard(() => Promise.allSettled([...activeLoops.values()]))
          .catch(() => undefined);
        reconciler.stop();
        if (!stateOwner.signal.aborted)
          await stateOwner.guard(() => reconciler.idle()).catch(() => undefined);
      }
      stateOwner.signal.removeEventListener("abort", halt);
      await rawStore.close?.();
      if (ownsOwnership) await stateOwner.close();
    },
  };
}

export type Factory = Awaited<ReturnType<typeof createFactory>>;

export async function createFactory(options: FactoryOptions) {
  const stateOwner = options.stateOwner ?? new PrivateStateOwner(options.dataDir);
  try {
    stateOwner.assertDirectory(options.dataDir);
    stateOwner.claimFactory();
    return await createOwnedFactory(
      { ...options, dataDir: stateOwner.directory },
      stateOwner,
      !options.stateOwner,
    );
  } catch (error) {
    if (!options.stateOwner) await stateOwner.close();
    throw error;
  }
}
