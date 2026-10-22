import { type BusEvent, EventBus, type WorkflowState } from "@matrix/core";
import type { TicketStore } from "@matrix/tickets";
import { LinearTicketStore } from "@matrix/tickets/adapters/linear";
import { fakeLinear } from "@matrix/tickets/testing/linear-fake";
import { describe, expect, test } from "vitest";
import { TrackerHealth } from "./tracker-health.js";
import { renderStatus, safeLink } from "./tracker-status.js";
import { TrackerSync } from "./tracker-sync.js";

const KEY = `lin_api_${"x".repeat(16)}`;
const at = new Date("2026-10-22T10:00:00Z");

function setup(store?: TicketStore) {
  const fake = fakeLinear();
  const linear = new LinearTicketStore({
    teamKey: "NEO",
    projectLabel: "project:demo",
    fetch: fake.fetch,
    env: { LINEAR_API_KEY: KEY },
    sleep: async () => {},
  });
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const sync = new TrackerSync({
    bus,
    tickets: async () => store ?? linear,
    debounceMs: 60_000,
    clock: () => at,
  });
  sync.start();
  return { fake, linear, bus, events, sync };
}

const wf = (ticketId: string, patch: Partial<WorkflowState>): WorkflowState => ({
  projectId: "p1",
  ticketId,
  phase: "spike",
  status: "running",
  attempt: 1,
  loops: 0,
  priority: 2,
  version: 1,
  ...patch,
});

describe("TrackerSync", () => {
  test("coalesces a burst into one column move and one live comment", async () => {
    const { fake, linear, bus, sync } = setup();
    const t = await linear.create({ title: "T", body: "" });
    for (const phase of ["spike", "implement", "checks", "review"] as const)
      bus.publish({ type: "workflow.changed", workflow: wf(t.id, { phase }) });
    await sync.flush();
    expect(fake.issues.get(t.id)?.state.name).toBe("Review");
    expect(fake.calls.filter((c) => c.op === "MatrixComment")).toHaveLength(1);
    const [comment] = [...fake.comments.values()];
    expect(comment?.body).toContain("phase `review`");
    expect(comment?.body).toContain("_Updated 2026-10-22T10:00:00.000Z_");
    // Same rendered state again: no API write at all.
    const calls = fake.calls.length;
    bus.publish({ type: "workflow.changed", workflow: wf(t.id, { phase: "review", version: 2 }) });
    await sync.flush();
    expect(fake.calls.length).toBe(calls);
  });

  test("edits the same comment through merge approval and done, with receipt links", async () => {
    const { fake, linear, bus, sync } = setup();
    const t = await linear.create({ title: "T", body: "" });
    bus.publish({
      type: "run.started",
      runId: "r1",
      projectId: "p1",
      ticketId: t.id,
      phase: "merge",
    });
    bus.publish({ type: "workflow.changed", workflow: wf(t.id, { phase: "merge" }) });
    await sync.flush();
    bus.publish({
      type: "run.finished",
      runId: "r1",
      status: "ok",
      summary: "",
      receipts: [
        { kind: "log", ok: true, summary: "pr", url: "https://github.com/o/r/pull/7" },
        { kind: "log", ok: true, summary: "x", url: "javascript:alert(1)" },
      ],
    });
    bus.publish({
      type: "workflow.changed",
      workflow: wf(t.id, { phase: "merge", status: "waiting_approval", lastError: "boom" }),
    });
    await sync.flush();
    expect(fake.issues.get(t.id)?.state.name).toBe("Awaiting merge");
    bus.publish({
      type: "workflow.changed",
      workflow: wf(t.id, { phase: "merge", status: "done" }),
    });
    await sync.flush();
    expect(fake.issues.get(t.id)?.state.name).toBe("Done");
    expect(fake.comments.size).toBe(1);
    const body = [...fake.comments.values()][0]?.body ?? "";
    expect(body).toContain("[log](https://github.com/o/r/pull/7)");
    expect(body).not.toContain("javascript:");
    expect(body).toContain("`done`");
  });

  test("a draft PR lands in the live comment while the issue sits in Awaiting merge", async () => {
    const { fake, linear, bus, sync } = setup();
    const t = await linear.create({ title: "T", body: "" });
    bus.publish({
      type: "workflow.changed",
      workflow: wf(t.id, { phase: "merge", status: "waiting_approval" }),
    });
    for (const url of ["https://github.com/acme/app/pull/9", "javascript:alert(1)"])
      bus.publish({
        type: "pull_request.opened",
        projectId: "p1",
        ticketId: t.id,
        url,
        branch: "matrix-NEO-1-x",
      });
    await sync.flush();
    expect(fake.issues.get(t.id)?.state.name).toBe("Awaiting merge");
    const body = [...fake.comments.values()][0]?.body ?? "";
    expect(body).toContain("Draft PR: [matrix-NEO-1-x](https://github.com/acme/app/pull/9)");
    expect(body).not.toContain("javascript:");
  });

  test("the live comment names the ticket's Orca Run; malformed refs are dropped", async () => {
    const { fake, linear, bus, sync } = setup();
    const t = await linear.create({ title: "T", body: "" });
    bus.publish({
      type: "run.started",
      runId: "r2",
      projectId: "p1",
      ticketId: t.id,
      phase: "review",
    });
    bus.publish({ type: "workflow.changed", workflow: wf(t.id, { phase: "review" }) });
    bus.publish({
      type: "run.finished",
      runId: "r2",
      status: "ok",
      summary: "",
      receipts: [
        { kind: "log", ok: true, summary: "bad", data: { orca: { run: "run_x](https://evil)" } } },
        {
          kind: "log",
          ok: true,
          summary: "orca",
          data: { orca: { run: "run_abc", dispatch: "ctx_1" } },
        },
      ],
    });
    await sync.flush();
    const body = [...fake.comments.values()][0]?.body ?? "";
    expect(body).toContain("- Orca: Run `run_abc` · dispatch `ctx_1`");
    expect(body).not.toContain("evil");
  });

  test("tracker failures become events and never throw; adapters without capabilities get no writes", async () => {
    const { fake, linear, bus, events, sync } = setup();
    const t = await linear.create({ title: "T", body: "" });
    for (let i = 0; i < 30; i++) fake.queue.push({ status: 503, body: "down" });
    bus.publish({ type: "workflow.changed", workflow: wf(t.id, {}) });
    await sync.flush();
    const failed = events.filter((e) => e.type === "tracker.failed");
    expect(failed.map((e) => e.type === "tracker.failed" && e.operation)).toContain("setPhase");
    expect(failed[0]).toMatchObject({ projectId: "p1", ticketId: t.id });

    const plain = { kind: "markdown", update: () => Promise.reject(new Error("no")) };
    const other = setup(plain as unknown as TicketStore);
    other.bus.publish({ type: "workflow.changed", workflow: wf("T-1", {}) });
    await other.sync.flush();
    expect(other.events.filter((e) => e.type === "tracker.failed")).toEqual([]);
  });
});

test("a failed write is retried without waiting for the next workflow change", async () => {
  const { fake, linear, bus, events, sync } = setup();
  const t = await linear.create({ title: "T", body: "" });
  fake.queue.push({ status: 200, body: { data: null, errors: [{ message: "boom" }] } });
  bus.publish({ type: "workflow.changed", workflow: wf(t.id, { status: "done" }) });
  await sync.flush();
  expect(events.some((e) => e.type === "tracker.failed")).toBe(true);
  expect(fake.issues.get(t.id)?.state.name).toBe("Done");
  expect(fake.comments.size).toBe(1);
});

describe("tracker status rendering", () => {
  test("redacts and single-lines errors; only https links", () => {
    const body = renderStatus(
      wf("NEO-1", { lastError: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n# injected `x`" }),
      [],
    );
    expect(body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(body.split("\n")).toHaveLength(3);
    expect(safeLink("pr", "http://x.test/a")).toBeUndefined();
    expect(safeLink("pr", "https://x.test/a)(b")).toBeUndefined();
    expect(safeLink("p[r]", "https://x.test/a")).toEqual({ label: "pr", url: "https://x.test/a" });
  });

  test("TrackerHealth keeps newest-first failures per project and logs JSON", () => {
    const bus = new EventBus();
    const logs: string[] = [];
    const health = new TrackerHealth(bus, (m) => logs.push(m), 2);
    health.start();
    for (const op of ["a", "b", "c"])
      bus.publish({
        type: "tracker.failed",
        projectId: "p1",
        operation: op,
        message: "m",
        at: "t",
      });
    expect(health.failures("p1").map((f) => f.operation)).toEqual(["c", "b"]);
    expect(health.failures("p2")).toEqual([]);
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({ level: "warn", event: "tracker.failed" });
  });
});
