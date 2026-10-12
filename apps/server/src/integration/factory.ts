import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCompoundHandler } from "@matrix/compound";
import {
  createDefaultHandlers,
  EventBus,
  HoldoutStore,
  MemoryStore,
  PgStore,
  Reconciler,
  type Store,
} from "@matrix/core";
import { GatewayLlm, type LlmClient } from "@matrix/monitor";
import type { TicketStore } from "@matrix/tickets";
import { runWatch } from "@matrix/watch";
import { repoKnowledge } from "./knowledge.js";
import { fakeTriageLlm, ServerMonitor } from "./monitor.js";
import type { NativeRuntimeOptions } from "./native-runtime.js";
import { RealCore } from "./real-core.js";
import { createRuntime, type RuntimeKind } from "./runtime.js";
import type { TicketBinaries, TicketSettings } from "./tickets.js";

export interface FactoryOptions {
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
): Promise<void> {
  const git = (...args: string[]) => run("git", ["-C", repoPath, ...args]);
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Project Matrix");
  await git("config", "user.email", "matrix@localhost");
  await writeFile(join(repoPath, "README.md"), "# New project\n\nCreated by Project Matrix.\n", {
    flag: "wx",
  }).catch(() => undefined);
  await git("add", "README.md");
  await git("commit", "-q", "-m", "chore: initial commit");
  if (tickets.kind === "beads") {
    await run(
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

export async function createFactory(options: FactoryOptions) {
  const log = options.log ?? ((m: string) => console.log(m));
  const runtime = createRuntime(
    options.runtime,
    options.native ? { ...options.native, dataDir: options.dataDir } : undefined,
  );
  mkdirSync(join(options.dataDir, "projects"), { recursive: true, mode: 0o700 });
  mkdirSync(join(options.dataDir, "holdout"), { recursive: true, mode: 0o700 });

  const store: Store & { close?: () => Promise<void> } = options.databaseUrl
    ? await PgStore.connect(options.databaseUrl, { migrate: true })
    : new MemoryStore();
  const bus = new EventBus();
  const holdout = new HoldoutStore(join(options.dataDir, "holdout"));
  const handlers = {
    ...createDefaultHandlers({ ...runtime.deps, store, holdout }),
    compound: createCompoundHandler({ store }),
  };

  let core: RealCore | undefined;
  const tickets = (projectId: string) =>
    lazyTickets(async () => {
      if (!core) throw new Error("factory not ready");
      return core.ticketStore(projectId);
    });

  const reconciler = new Reconciler({
    store,
    bus,
    handlers,
    workspace: runtime.workspace,
    git: runtime.git,
    tickets,
    limits: { perProject: 4, perModel: {}, defaultPerModel: 4, perHost: {}, defaultPerHost: 8 },
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
          return new GatewayLlm(options.gateway);
        })();

  const monitor = new ServerMonitor({
    llm,
    model: options.triageModel ?? "gpt-6.1-sol",
    tickets: async (projectId) => {
      if (!core) throw new Error("factory not ready");
      return core.ticketStore(projectId);
    },
    projectIds: async () => (await store.listProjects()).map((p) => p.id),
  });

  core = new RealCore({
    store,
    bus,
    reconciler,
    projectsRoot: join(options.dataDir, "projects"),
    host: options.host,
    knowledge: repoKnowledge,
    monitor,
    initRepo: (repoPath, tickets) => initProjectRepo(repoPath, tickets, options.binaries),
    ...(options.binaries ? { binaries: options.binaries } : {}),
  });

  const timers: ReturnType<typeof setInterval>[] = [];
  const guarded = (name: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (error) {
      log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const watchAll = async () => {
    for (const project of await store.listProjects()) {
      const result = await runWatch({
        root: project.repoPath,
        tickets: await (core as RealCore).ticketStore(project.id),
        ...(options.gateway
          ? {
              gateway: {
                baseUrl: options.gateway.baseUrl,
                apiKey: options.gateway.apiKey,
                model: options.triageModel ?? "gpt-6.1-sol",
              },
            }
          : {}),
      });
      log(`watch ${project.id}: ${result.relevant} relevant, ${result.tickets.length} tickets`);
    }
  };

  return {
    core,
    store,
    bus,
    reconciler,
    monitor,
    runtime: runtime.kind,
    /** Starts the reconcile, monitor and (optional) weekly watch loops. */
    start() {
      const tick = guarded("reconcile", () => reconciler.tick());
      const monitorTick = guarded("monitor", () => monitor.tick());
      timers.push(setInterval(tick, options.tickMs ?? 5_000));
      timers.push(setInterval(monitorTick, options.monitorMs ?? 30_000));
      if (options.watch)
        timers.push(setInterval(guarded("watch", watchAll), 7 * 24 * 60 * 60 * 1000));
      for (const t of timers) t.unref?.();
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      reconciler.stop();
      await reconciler.idle();
      await store.close?.();
    },
  };
}

export type Factory = Awaited<ReturnType<typeof createFactory>>;
