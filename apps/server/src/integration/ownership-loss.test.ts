import { type ChildProcess, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleAnswers } from "@matrix/packs";
import type { NewTicket, Ticket, TicketStore } from "@matrix/tickets";
import { expect, test, vi } from "vitest";
import { createServer } from "../http/app.js";
import { PrivateStateOwner } from "../state-owner.js";
import { createFactory } from "./factory.js";
import { ownedExternalTickets } from "./owned-tickets.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function deferredTracker() {
  const entered = deferred<void>();
  const response = deferred<void>();
  const records: Ticket[] = [];
  const create = vi.fn(async (input: NewTicket) => {
    const ticket: Ticket = {
      id: `fake-external-${records.length + 1}`,
      title: input.title,
      body: input.body,
      status: "open",
      labels: input.labels ?? [],
      deps: input.deps ?? [],
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
    };
    records.push(ticket);
    entered.resolve();
    await response.promise;
    return ticket;
  });
  const update = vi.fn(async () => {
    throw new Error("unexpected tracker update");
  });
  const comment = vi.fn(async () => {});
  const store: TicketStore = {
    kind: "github",
    list: async () => records,
    get: async (id) => records.find((record) => record.id === id) ?? null,
    create,
    update,
    comment,
    link: async () => {},
    ready: async () => [],
  };
  return { store, entered, response, create, update, comment, records };
}

function snapshot(directory: string, path = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(directory, path), { withFileTypes: true })) {
    if (entry.name.startsWith(".state-owner")) continue;
    const relative = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(directory, relative));
    else
      files[relative] = createHash("sha256")
        .update(readFileSync(join(directory, relative)))
        .digest("hex");
  }
  return files;
}

function replaceGuardian(owner: PrivateStateOwner): PrivateStateOwner {
  const child = Reflect.get(owner, "child") as ChildProcess;
  expect(child.kill("SIGKILL")).toBe(true);
  spawnSync("sleep", ["0.05"]);
  const next = new PrivateStateOwner(owner.directory);
  expect(() => owner.assertOwned()).toThrow("ownership lost");
  expect(owner.signal.aborted).toBe(true);
  next.assertOwned();
  return next;
}

test("guardian-only loss fences deferred finalize after a second owner acquires, without draining", async () => {
  const directory = mkdtempSync(join(tmpdir(), "matrix-finalize-guardian-"));
  const factory = await createFactory({
    runtime: "fake",
    dataDir: directory,
    host: "test",
    log: () => {},
  });
  const server = createServer({ core: factory.core, stateDir: directory });
  const tracker = deferredTracker();
  const adapter = vi.spyOn(factory.core, "ticketStore").mockResolvedValue(tracker.store);
  const saved = vi.spyOn(factory.store, "saveInitializedProject");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let next: PrivateStateOwner | undefined;
  try {
    const project = await factory.core.createProject({
      name: "ownership-fixture",
      description: "",
      workspace: "native",
      tickets: { kind: "github", repo: "fixture/not-real" },
    });
    const session = await factory.core.startInit(project.id);
    await factory.core.answerInit(session.id, { ...sampleAnswers, "process.tickets": "github" });
    const pending = factory.core.finalizeInit(session.id, { acceptRecommended: true });
    const failure = expect(pending).rejects.toThrow("ownership lost");
    await tracker.entered.promise;
    const before = snapshot(directory);
    next = replaceGuardian(factory.stateOwner);
    await failure;
    expect((await server.app.request("/healthz")).status).toBe(503);
    await factory.stop();
    await server.close();
    tracker.response.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(snapshot(directory)).toEqual(before);
    expect(saved).not.toHaveBeenCalled();
    expect(tracker.create).toHaveBeenCalledTimes(1);
    expect(tracker.update).not.toHaveBeenCalled();
    expect((await factory.core.getInit(session.id))?.state).toBe("in_progress");
    expect(existsSync(join(directory, "projects", project.id, "matrix.config.ts"))).toBe(false);
    const journal = JSON.parse(
      readFileSync(join(directory, "projects", `${project.id}.init.json`), "utf8"),
    );
    expect(journal.ticketIntents).toHaveLength(1);
    expect(journal.ticketMap).toEqual({});
    expect(journal.completed).toBeUndefined();
  } finally {
    tracker.response.resolve();
    adapter.mockRestore();
    saved.mockRestore();
    errors.mockRestore();
    await server.close();
    await factory.stop();
    await next?.close();
  }
}, 30_000);

test("guardian-only monitor loss preserves pending intent and forbids old-owner issue writes or tracker updates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "matrix-monitor-guardian-"));
  const factory = await createFactory({
    runtime: "fake",
    dataDir: directory,
    host: "test",
    log: () => {},
  });
  const tracker = deferredTracker();
  const adapter = vi.spyOn(factory.core, "ticketStore").mockResolvedValue(tracker.store);
  let next: PrivateStateOwner | undefined;
  try {
    const project = await factory.core.createProject({
      name: "monitor-fixture",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    });
    await factory.monitor.ingest({
      source: "sentry",
      kind: "error",
      projectId: project.id,
      title: "TypeError: cannot read price",
      receivedAt: new Date().toISOString(),
      payload: {
        data: {
          issue: { id: "fixture-42", title: "TypeError: cannot read price", level: "error" },
          event: { title: "TypeError: cannot read price", level: "error", platform: "node" },
        },
      },
    });
    const pending = factory.monitor.tick();
    const failure = expect(pending).rejects.toThrow("ownership lost");
    await tracker.entered.promise;
    const before = snapshot(directory);
    next = replaceGuardian(factory.stateOwner);
    await failure;
    await factory.stop();
    tracker.response.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(snapshot(directory)).toEqual(before);
    expect(tracker.create).toHaveBeenCalledTimes(1);
    expect(tracker.update).not.toHaveBeenCalled();
    expect(tracker.comment).not.toHaveBeenCalled();
    expect(() =>
      factory.monitor.buffer.push({
        source: "sentry",
        kind: "error",
        title: "late",
        payload: {},
        receivedAt: new Date().toISOString(),
      }),
    ).toThrow("ownership lost");
    const journalFile = join(directory, "projects", `${project.id}.monitor-tickets.json`);
    const input = tracker.create.mock.calls[0]![0];
    const restarted = ownedExternalTickets(tracker.store, next, journalFile);
    expect((await restarted.create(input)).id).toBe(tracker.records[0]!.id);
    expect(tracker.create).toHaveBeenCalledTimes(1);
    tracker.records.length = 0;
    await expect(restarted.create(input)).rejects.toThrow("outcome unknown");
    expect(tracker.create).toHaveBeenCalledTimes(1);
  } finally {
    tracker.response.resolve();
    adapter.mockRestore();
    await factory.stop();
    await next?.close();
  }
}, 30_000);
