import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCompoundHandler } from "@matrix/compound";
import {
  createDefaultHandlers,
  EventBus,
  MemoryStore,
  PgStore,
  Reconciler,
  type Store,
} from "@matrix/core";
import { GatewayLlm, type LlmClient } from "@matrix/monitor";
import type { TicketStore } from "@matrix/tickets";
import { fileProposals, runWatch, SeenStore } from "@matrix/watch";
import { PrivateState } from "../private-state.js";
import { PrivateStateOwner } from "../state-owner.js";
import { repoKnowledge } from "./knowledge.js";
import { fakeTriageLlm, ServerMonitor } from "./monitor.js";
import type { NativeRuntimeOptions } from "./native-runtime.js";
import { publishOwnedFile } from "./owned-files.js";
import { OwnedHoldoutStore } from "./owned-holdout.js";
import { ownedExternalTickets } from "./owned-tickets.js";
import { RealCore } from "./real-core.js";
import { createRuntime, type RuntimeKind } from "./runtime.js";
import type { TicketBinaries, TicketSettings } from "./tickets.js";

export interface FactoryOptions {
  stateOwner?: PrivateStateOwner;
  runtime: RuntimeKind;
  /** Required for the native and orca runtimes. */
  native?: Omit<NativeRuntimeOptions, "workspace" | "dataDir">;
  /** Postgres URL; without it the factory runs on the in-memory store (dev and tests only). */
  databaseUrl?: string;
  dataDir: string;
  host: string;
  /** OpenAI-compatible gateway for triage; required unless the runtime is fake. */
  gateway?: { baseUrl: string; apiKey: string };
  triageModel?: string;
  tickMs?: number;
  monitorMs?: number;
  /** Weekly tech watch over every project (network access). */
  watch?: boolean;
  log?: (message: string) => void;
  binaries?: TicketBinaries;
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
  const execute = async (binary: string, args: string[], options: { cwd?: string } = {}) => {
    owner?.assertOwned();
    const result = await run(binary, args, { ...options, signal: owner?.signal });
    owner?.assertOwned();
    return result;
  };
  const git = (...args: string[]) => execute("git", ["-C", repoPath, ...args]);
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Project Matrix");
  await git("config", "user.email", "matrix@localhost");
  await git("commit", "--allow-empty", "-q", "-m", "chore: initial commit");
  if (tickets.kind === "beads") {
    await execute(
      binaries.bd ?? "bd",
      ["init", "--non-interactive", "--quiet", "--stealth", "--prefix", "mx"],
      {
        cwd: repoPath,
      },
    );
  }
}

/** A TicketStore whose backing adapter is resolved per call (the reconciler needs it synchronously). */
function lazyTickets(resolve: () => Promise<TicketStore>): TicketStore {
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
    options.native ? { ...options.native, dataDir: options.dataDir, stateOwner } : undefined,
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
  const handlers = {
    ...createDefaultHandlers({ ...runtime.deps, store, holdout }),
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
    limits: {
      perProject: options.runtime === "fake" ? 4 : 1,
      perModel: {},
      defaultPerModel: options.runtime === "fake" ? 4 : 1,
      perHost: {},
      defaultPerHost: options.runtime === "fake" ? 8 : 1,
    },
    backoff: { baseMs: 5_000, maxMs: 10 * 60_000 },
    host: options.host,
    scratchRoot: join(options.dataDir, "scratch"),
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

  core = new RealCore({
    stateOwner,
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
    ...(options.binaries ? { binaries: options.binaries } : {}),
  });

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
