import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleAnswers } from "@matrix/packs";
import type { TicketStore } from "@matrix/tickets";
import { MemoryStore as MemoryTickets } from "@matrix/tickets/adapters/memory";
import { expect, test, vi } from "vitest";
import { createServer } from "../http/app.js";
import { PrivateState } from "../private-state.js";
import { createFactory } from "./factory.js";
import type { FinalizeJournal } from "./finalize.js";

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const trackers: ("markdown" | "beads")[] = ["markdown"];
if (process.env.MATRIX_TEST_BD_BINARY) trackers.push("beads");

test("finalize gates both ready discovery and already-pending workflows until commit", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "matrix-finalize-gate-"));
  const factory = await createFactory({
    runtime: "fake",
    dataDir,
    host: "test-host",
    log: () => undefined,
  });
  const memory = new MemoryTickets();
  const tracker: TicketStore = {
    kind: "beads",
    list: memory.list.bind(memory),
    get: memory.get.bind(memory),
    create: memory.create.bind(memory),
    update: memory.update.bind(memory),
    comment: memory.comment.bind(memory),
    link: memory.link.bind(memory),
    ready: memory.ready.bind(memory),
  };
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mirrored = (_id: string) => {};
  const firstTicket = new Promise<string>((resolve) => {
    mirrored = resolve;
  });
  const create = vi.spyOn(tracker, "create").mockImplementation(async (input) => {
    const ticket = await memory.create(input);
    mirrored(ticket.id);
    await held;
    return ticket;
  });
  const ready = vi.spyOn(tracker, "ready");
  vi.spyOn(factory.core, "ticketStore").mockResolvedValue(tracker);
  let finalizing: ReturnType<typeof factory.core.finalizeInit> | undefined;
  try {
    const project = await factory.core.createProject({
      name: "gate",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    });
    const session = await factory.core.startInit(project.id);
    await factory.core.answerInit(session.id, { ...sampleAnswers, "process.tickets": "beads" });
    finalizing = factory.core.finalizeInit(session.id, { acceptRecommended: true });
    const ticketId = await bounded(firstTicket, "first mirrored ticket");
    await factory.store.createWorkflow({
      projectId: project.id,
      ticketId,
      phase: "spike",
      status: "pending",
      attempt: 0,
      loops: 0,
      priority: 2,
      version: 0,
    });
    const report = await bounded(factory.reconciler.tick(), "gated tick");
    expect(report.dispatched).toEqual([]);
    expect(report.skipped).toContainEqual({ ticketId, reason: "project finalize incomplete" });
    expect(ready).not.toHaveBeenCalled();
    expect(await factory.store.listRuns()).toEqual([]);
    expect(factory.core.projectDispatchAllowed(project.id)).toBe(false);
    release();
    expect((await bounded(finalizing, "finalize", 10_000)).state).toBe("completed");
    expect(factory.core.projectDispatchAllowed(project.id)).toBe(true);
    create.mockRestore();
    const journal = new PrivateState<FinalizeJournal | null>(
      join(dataDir, "projects", `${project.id}.init.json`),
      factory.stateOwner,
    );
    const completed = journal.load(null)!;
    const incomplete = { ...completed };
    delete incomplete.completed;
    journal.save(incomplete);
    expect(factory.core.projectDispatchAllowed(project.id)).toBe(false);
    expect((await factory.reconciler.tick()).dispatched).toEqual([]);
    expect(ready).not.toHaveBeenCalled();
    journal.save(completed);
    expect((await factory.reconciler.tick()).dispatched.length).toBeGreaterThan(0);
    await factory.reconciler.idle();
    expect(ready).toHaveBeenCalled();
  } finally {
    release();
    await finalizing?.catch(() => undefined);
    vi.restoreAllMocks();
    await factory.stop();
  }
}, 30_000);

test.each(trackers)(
  "%s: runs and overview settle after real finalize with a stalled tracker",
  async (kind) => {
    const factory = await createFactory({
      runtime: "fake",
      dataDir: mkdtempSync(join(tmpdir(), "matrix-finalize-runs-")),
      host: "test-host",
      log: () => undefined,
      ...(process.env.MATRIX_TEST_BD_BINARY
        ? { binaries: { bd: process.env.MATRIX_TEST_BD_BINARY } }
        : {}),
    });
    const server = createServer({ core: factory.core });
    const { token } = server.keys.create({
      name: "test",
      scope: { projects: "*", actions: ["admin"] },
    });
    const call = async (method: string, path: string, body?: unknown) =>
      server.app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      expect(await bounded(factory.core.listRuns(), "fresh listRuns")).toEqual([]);
      expect((await bounded(call("GET", "/v1/overview"), "fresh overview")).status).toBe(200);
      const created = await call("POST", "/v1/projects", {
        name: "repro",
        description: "",
        workspace: "native",
        tickets: { kind },
      });
      expect(created.status).toBe(200);
      const project = (await created.json()) as { id: string };
      const session = (await (
        await call("POST", `/v1/projects/${project.id}/init`, {})
      ).json()) as {
        id: string;
      };
      expect(
        (await call("POST", `/v1/init/${session.id}/answers`, { answers: sampleAnswers })).status,
      ).toBe(200);
      const finalized = await call("POST", `/v1/init/${session.id}/finalize`, {
        acceptRecommended: true,
      });
      expect(await finalized.json()).toMatchObject({
        state: "completed",
        result: { status: "ok" },
      });
      await bounded(factory.reconciler.tick(), "tick", kind === "beads" ? 12_000 : 2_000);
      await bounded(factory.reconciler.idle(), "idle", kind === "beads" ? 60_000 : 2_000);
      await bounded(factory.core.syncTickets(project.id), "ticket sync", 12_000);
      const records = await bounded(factory.store.listRuns(), "raw runs");
      expect(records.length).toBeGreaterThan(0);
      await factory.store.createApproval({
        id: "pending-approval",
        projectId: project.id,
        ticketId: records[0]!.ticketId,
        phase: records[0]!.phase,
        runId: records[0]!.id,
        headSha: "fixture-sha",
        requestedBy: records[0]!.ownerId,
        status: "pending",
        requestedAt: new Date(),
      });
      const tracker = await factory.core.ticketStore(project.id);
      const ticket = await tracker.get(records[0]!.ticketId);
      expect(ticket).not.toBeNull();
      const get = vi.spyOn(tracker, "get").mockImplementation(() => new Promise(() => {}));
      const list = vi.spyOn(tracker, "list").mockImplementation(() => new Promise(() => {}));
      const ready = vi.spyOn(tracker, "ready").mockImplementation(() => new Promise(() => {}));
      const tickets = await bounded(factory.core.listTickets(project.id), "board tickets");
      expect(tickets.length).toBeGreaterThan(0);
      expect(tickets).toContainEqual(ticket);
      expect(
        await bounded(factory.core.getTicket(project.id, ticket!.id), "indexed ticket"),
      ).toEqual(ticket);
      const board = await bounded(
        call("GET", `/v1/projects/${project.id}/tickets`),
        "board endpoint",
      );
      expect(board.status).toBe(200);
      expect(await board.json()).toHaveLength(tickets.length);
      expect(
        await bounded(
          factory.core.listTickets(project.id, {
            status: [ticket!.status],
            labels: ticket!.labels,
          }),
          "filtered board",
        ),
      ).toContainEqual(ticket);
      const runs = await bounded(factory.core.listRuns(), "listRuns");
      const [response, overview] = await bounded(
        Promise.all([call("GET", "/v1/runs"), call("GET", "/v1/overview")]),
        "run reads",
      );
      expect(runs).toHaveLength(records.length);
      expect(runs[0]?.title).toBe(ticket?.title);
      expect(runs[0]?.state).toBe("awaiting_approval");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([{ title: ticket?.title }]);
      expect(overview.status).toBe(200);
      expect(await overview.json()).toMatchObject({ activeRuns: 1, pendingApprovals: 1 });
      expect((await bounded(factory.core.getRun(records[0]!.id), "getRun"))?.title).toBe(
        ticket?.title,
      );
      const title = vi.spyOn(factory.store, "getIndexedTicketTitle").mockResolvedValue(null);
      expect(
        await bounded(factory.core.getRun(records[0]!.id), "unindexed getRun"),
      ).not.toHaveProperty("title");
      title.mockRestore();
      expect(get).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
      get.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await server.close();
      await factory.stop();
    }
  },
  120_000,
);
