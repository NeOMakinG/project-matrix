import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BusEvent, EventBus } from "../bus.js";
import { createDefaultHandlers, type HandlerDeps } from "../handlers.js";
import { HoldoutStore } from "../holdout.js";
import type { Receipt, RunRequest, RunResult } from "../ports.js";
import type { ActionRequest } from "../ports-internal.js";
import { Reconciler } from "../reconcile.js";
import { type Actor, MemoryStore, type Store } from "../store.js";
import type { Limits, ProjectConfig } from "../types.js";
import {
  FakeGit,
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
  qaReceipts?: () => Receipt[];
  leaseMs?: number;
}

const SCENARIOS = JSON.stringify({
  scenarios: [
    { id: "s1", given: "a user", when: "they sign up", then: "they see the dashboard" },
    { id: "s2", given: "a user", when: "they log out", then: "they see the login page" },
  ],
});

export const APPROVER: Actor = { id: "user:valentin", kind: "human" };

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
  const git = new FakeGit();
  const holdout = new HoldoutStore(mkdtempSync(join(tmpdir(), "matrix-holdout-")));
  const merges: ActionRequest[] = [];
  const deploys: ActionRequest[] = [];
  let implementCalls = 0;
  let reviewCalls = 0;

  const implementer = new FakeRunner("claude-code", async (req, signal) => {
    if (req.phase === "implement") {
      return (await opts.implement?.(req, implementCalls++, signal)) ?? { summary: "implemented" };
    }
    return { summary: "plan: 3 steps" };
  });
  const reviewer = new FakeRunner("codex", (req) => {
    if (req.prompt.includes("acceptance scenarios")) return { summary: SCENARIOS };
    if (req.phase === "review") {
      return { summary: opts.findings?.(req, reviewCalls++) ?? '{"findings":[]}' };
    }
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
    qa: { run: async () => opts.qaReceipts?.() ?? qaEvidence() },
    merge: {
      merge: async (_ctx, request) => {
        merges.push(request);
        return { ok: true, summary: "merged PR #1", url: "https://example.test/pr/1" };
      },
    },
    deploy: {
      deploy: async (_ctx, request) => {
        deploys.push(request);
        return { ok: true, summary: "deployed" };
      },
    },
    verify: { verify: async () => [{ kind: "curl", ok: true, summary: "GET / 200" }] },
  };

  const project = testProject(opts.project);
  const makeReconciler = (ownerId: string) =>
    new Reconciler({
      store,
      bus,
      handlers: createDefaultHandlers(deps),
      workspace,
      git,
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
      leaseMs: opts.leaseMs ?? 600_000,
      heartbeatMs: 3_600_000,
      host: "bosgame",
      ownerId,
      clock: () => now,
      ids: () => `${prefix}-${++seq}`,
    });
  const reconciler = makeReconciler(`reconciler:${prefix}-a`);

  return {
    store,
    bus,
    events,
    tickets,
    workspace,
    sandbox,
    git,
    holdout,
    implementer,
    reviewer,
    deps,
    merges,
    deploys,
    project,
    reconciler,
    makeReconciler,
    advanceClock(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    async setup() {
      await store.upsertProject(project);
    },
    /** Tick until nothing is left to dispatch (or the cap is hit). */
    async drain(maxTicks = 50, r: Reconciler = reconciler) {
      for (let i = 0; i < maxTicks; i++) {
        const report = await r.tick();
        await r.idle();
        if (report.dispatched.length === 0 && report.replayed.length === 0) {
          const pending = await store.listWorkflows({ status: ["pending"] });
          if (pending.length === 0) return;
          now = new Date(now.getTime() + 60_000);
        }
      }
    },
  };
}
