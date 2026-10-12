import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BusEvent, EventBus } from "../bus.js";
import { createDefaultHandlers, type HandlerDeps } from "../handlers.js";
import { HoldoutStore } from "../holdout.js";
import type { RunRequest, RunResult } from "../ports.js";
import { Reconciler } from "../reconcile.js";
import { MemoryStore, type Store } from "../store.js";
import type { Limits, ProjectConfig } from "../types.js";
import {
  FakeRunner,
  FakeSandbox,
  FakeTicketStore,
  FakeWorkspace,
  qaEvidence,
  testProject,
} from "./fakes.js";

export interface HarnessOptions {
  project?: Partial<ProjectConfig>;
  limits?: Partial<Limits>;
  store?: Store;
  findings?: (req: RunRequest, call: number) => string;
  verdicts?: (req: RunRequest) => string;
  implement?: (
    req: RunRequest,
    call: number,
    signal: AbortSignal,
  ) => Partial<RunResult> | Promise<Partial<RunResult>>;
  stallMs?: number;
}

const SCENARIOS = JSON.stringify({
  scenarios: [
    { id: "s1", given: "a user", when: "they sign up", then: "they see the dashboard" },
    { id: "s2", given: "a user", when: "they log out", then: "they see the login page" },
  ],
});

export function createHarness(opts: HarnessOptions = {}) {
  let now = new Date("2026-10-12T10:00:00Z");
  let seq = 0;
  const prefix = Math.random().toString(36).slice(2, 8);
  const store = opts.store ?? new MemoryStore();
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const tickets = new FakeTicketStore();
  const workspace = new FakeWorkspace();
  const sandbox = new FakeSandbox();
  const holdout = new HoldoutStore(mkdtempSync(join(tmpdir(), "matrix-holdout-")));
  let implementCalls = 0;
  let reviewCalls = 0;

  const implementer = new FakeRunner("claude-code", async (req, signal) => {
    if (req.phase === "implement")
      return (await opts.implement?.(req, implementCalls++, signal)) ?? { summary: "implemented" };
    return { summary: "plan: 3 steps" };
  });
  const reviewer = new FakeRunner("codex", (req) => {
    if (req.prompt.includes("acceptance scenarios")) return { summary: SCENARIOS };
    if (req.phase === "review")
      return { summary: opts.findings?.(req, reviewCalls++) ?? '{"findings":[]}' };
    if (req.phase === "qa") {
      return {
        summary:
          opts.verdicts?.(req) ??
          '{"verdicts":[{"id":"s1","satisfied":true},{"id":"s2","satisfied":true}]}',
      };
    }
    return { summary: "" };
  });

  const deps: HandlerDeps = {
    runners: { "claude-code": implementer, codex: reviewer },
    sandbox,
    holdout,
    store,
    qa: { run: async () => qaEvidence() },
    merge: {
      merge: async () => ({ ok: true, summary: "merged PR #1", url: "https://example.test/pr/1" }),
    },
    deploy: { deploy: async () => ({ ok: true, summary: "deployed" }) },
    verify: { verify: async () => [{ kind: "curl", ok: true, summary: "GET / 200" }] },
  };

  const project = testProject(opts.project);
  const reconciler = new Reconciler({
    store,
    bus,
    handlers: createDefaultHandlers(deps),
    workspace,
    tickets: (projectId) => (projectId === project.id ? tickets : new FakeTicketStore()),
    limits: {
      perProject: 4,
      perModel: {},
      defaultPerModel: 4,
      perHost: {},
      defaultPerHost: 8,
      ...opts.limits,
    },
    backoff: { baseMs: 1000, maxMs: 60_000 },
    stallMs: opts.stallMs ?? 600_000,
    host: "bosgame",
    clock: () => now,
    ids: () => `${prefix}-${++seq}`,
  });

  return {
    store,
    bus,
    events,
    tickets,
    workspace,
    sandbox,
    holdout,
    implementer,
    reviewer,
    deps,
    project,
    reconciler,
    advanceClock(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    async setup() {
      await store.upsertProject(project);
    },
    /** Tick until nothing is left to dispatch (or the cap is hit). */
    async drain(maxTicks = 50) {
      for (let i = 0; i < maxTicks; i++) {
        const r = await reconciler.tick();
        await reconciler.idle();
        if (r.dispatched.length === 0 && r.replayed.length === 0) {
          const pending = await store.listWorkflows({ status: ["pending"] });
          if (pending.length === 0) return;
          now = new Date(now.getTime() + 60_000);
        }
      }
    },
  };
}
