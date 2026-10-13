import { mkdtempSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ticket } from "@matrix/tickets";
import { expect, test, vi } from "vitest";
import { createServer } from "../http/app.js";
import { createFactory } from "./factory.js";
import { trackerDeadline } from "./tickets.js";

test("successful full sync removes deleted tickets but retains historical run titles", async () => {
  const factory = await createFactory({
    runtime: "fake",
    dataDir: mkdtempSync(join(tmpdir(), "matrix-sync-delete-")),
    host: "test",
    log: () => {},
  });
  try {
    const project = await factory.core.createProject({
      name: "delete",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    });
    const removed = await factory.core.createTicket(project.id, {
      title: "Deleted",
      body: "",
      labels: [],
    });
    const kept = await factory.core.createTicket(project.id, {
      title: "Kept",
      body: "",
      labels: [],
    });
    const config = await factory.store.getProject(project.id);
    const directory = join(config!.repoPath, ".matrix", "tickets");
    const file = (await readdir(directory)).find((name) => name.startsWith(`${removed.id}-`))!;
    await rm(join(directory, file));
    await factory.core.syncTickets(project.id);
    expect(await factory.core.listTickets(project.id)).toEqual([kept]);
    expect(await factory.core.getTicket(project.id, removed.id)).toBeNull();
    expect(await factory.store.getIndexedTicketTitle(project.id, removed.id)).toBe("Deleted");
    await rm(
      join(directory, (await readdir(directory)).find((name) => name.startsWith(`${kept.id}-`))!),
    );
    await factory.core.syncTickets(project.id);
    expect(await factory.core.listTickets(project.id)).toEqual([]);
  } finally {
    await factory.stop();
  }
});

test("failed full sync preserves all previous snapshot membership", async () => {
  const factory = await createFactory({
    runtime: "fake",
    dataDir: mkdtempSync(join(tmpdir(), "matrix-sync-failed-")),
    host: "test",
    log: () => {},
  });
  try {
    const project = await factory.core.createProject({
      name: "failed",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    });
    const first = await factory.core.createTicket(project.id, {
      title: "First",
      body: "",
      labels: [],
    });
    const second = await factory.core.createTicket(project.id, {
      title: "Second",
      body: "",
      labels: [],
    });
    const tracker = await factory.core.ticketStore(project.id);
    const list = vi.spyOn(tracker, "list").mockRejectedValue(new Error("tracker list failed"));
    const replace = vi.spyOn(factory.store, "replaceIndexedTickets");
    await expect(factory.core.syncTickets(project.id)).rejects.toThrow("tracker list failed");
    expect(replace).not.toHaveBeenCalled();
    expect(await factory.core.listTickets(project.id)).toEqual([first, second]);
    list.mockResolvedValue([first]);
    await factory.core.syncTickets(project.id);
    expect(await factory.core.listTickets(project.id)).toEqual([first]);
  } finally {
    vi.restoreAllMocks();
    await factory.stop();
  }
});

test("a mutation interleaved with a captured sync list publishes the newer snapshot last", async () => {
  const factory = await createFactory({
    runtime: "fake",
    dataDir: mkdtempSync(join(tmpdir(), "matrix-sync-race-")),
    host: "test",
    log: () => {},
  });
  let release = () => {};
  try {
    const project = await factory.core.createProject({
      name: "race",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    });
    const original = await factory.core.createTicket(project.id, {
      title: "Old",
      body: "",
      labels: [],
    });
    const tracker = await factory.core.ticketStore(project.id);
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(tracker, "list").mockImplementation(
      () =>
        new Promise<Ticket[]>((resolve) => {
          release = () => resolve([original]);
          entered();
        }),
    );
    const lock = vi.spyOn(factory.core, "withTicketSnapshotLock");
    const sync = factory.core.syncTickets(project.id);
    await started;
    const mutation = factory.core.updateTicket(project.id, original.id, { title: "New" });
    await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(2));
    expect((await tracker.get(original.id))?.title).toBe("Old");
    release();
    await sync;
    const updated = await mutation;
    expect(updated.title).toBe("New");
    expect(await factory.core.getTicket(project.id, original.id)).toEqual(updated);
    expect(await factory.store.getIndexedTicketTitle(project.id, original.id)).toBe("New");
  } finally {
    release();
    vi.restoreAllMocks();
    await factory.stop();
  }
});

async function restartProject(empty = false) {
  const options = {
    runtime: "fake" as const,
    dataDir: mkdtempSync(join(tmpdir(), "matrix-cold-tickets-")),
    host: "test",
    log: () => {},
  };
  const original = await createFactory(options);
  const saved = await (async () => {
    try {
      const project = await original.core.createProject({
        name: "cold",
        description: "",
        workspace: "native",
        tickets: { kind: "markdown" },
      });
      const tickets: Ticket[] = [];
      if (!empty) {
        for (const title of ["first", "second", "third"])
          tickets.push(
            await original.core.createTicket(project.id, {
              title,
              body: "persisted body",
              labels: ["persisted"],
            }),
          );
      }
      return { project, tickets, config: (await original.store.getProject(project.id))! };
    } finally {
      await original.stop();
    }
  })();
  const factory = await createFactory(options);
  await factory.store.upsertProject(saved.config);
  return { factory, ...saved };
}

test("cold memory snapshots hydrate once after restart, including concurrent and filtered reads", async () => {
  const { factory, project, tickets } = await restartProject();
  try {
    expect(await factory.store.listIndexedTickets(project.id)).toEqual([]);
    const tracker = await factory.core.ticketStore(project.id);
    const list = vi.spyOn(tracker, "list");
    const [all, ticket, filtered] = await Promise.all([
      factory.core.listTickets(project.id),
      factory.core.getTicket(project.id, tickets[0]!.id),
      factory.core.listTickets(project.id, { labels: ["absent"] }),
    ]);
    expect(all).toEqual(tickets);
    expect(ticket).toEqual(tickets[0]);
    expect(filtered).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockImplementation(() => new Promise(() => {}));
    expect(await factory.core.listTickets(project.id)).toEqual(tickets);
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
    await factory.stop();
  }
});

test("a successfully hydrated empty snapshot does not refetch on every read", async () => {
  const { factory, project } = await restartProject(true);
  try {
    const tracker = await factory.core.ticketStore(project.id);
    const list = vi.spyOn(tracker, "list");
    expect(await factory.core.getTicket(project.id, "missing")).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    list.mockImplementation(() => new Promise(() => {}));
    expect(await factory.core.listTickets(project.id)).toEqual([]);
    expect(await factory.core.getTicket(project.id, "still-missing")).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
    await factory.stop();
  }
});

test("stalled cold hydration returns typed HTTP 503, rejects late writes and permits recovery", async () => {
  const { factory, project, tickets } = await restartProject();
  const server = createServer({ core: factory.core });
  const { token } = server.keys.create({
    name: "cold-reader",
    scope: { projects: "*", actions: ["admin"] },
  });
  try {
    const tracker = await factory.core.ticketStore(project.id);
    let finish!: (records: Ticket[]) => void;
    const list = vi.spyOn(tracker, "list").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const read = () =>
      server.app.request(`/v1/projects/${project.id}/tickets`, {
        headers: { authorization: `Bearer ${token}` },
      });
    vi.useFakeTimers();
    const pending = read();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_001);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "tracker_unavailable" } });
    finish(tickets);
    await vi.advanceTimersByTimeAsync(0);
    expect(await factory.store.listIndexedTickets(project.id)).toEqual([]);
    list.mockResolvedValue(tickets);
    const recovered = await read();
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual(tickets);
    list.mockImplementation(() => new Promise(() => {}));
    expect(await factory.core.listTickets(project.id)).toEqual(tickets);
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await factory.stateOwner.close();
    await server.close();
    await factory.stop();
  }
});

test("background sync expires, preserves snapshots and ignores late tracker results", async () => {
  const factory = await createFactory({
    runtime: "fake",
    dataDir: mkdtempSync(join(tmpdir(), "matrix-sync-")),
    host: "test",
    log: () => {},
  });
  try {
    const project = await factory.core.createProject({
      name: "sync",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    });
    const ticket = await factory.core.createTicket(project.id, {
      title: "cached",
      body: "full body",
      deps: ["dependency"],
      labels: ["cached"],
    });
    const tracker = await factory.core.ticketStore(project.id);
    let finish!: (tickets: Ticket[]) => void;
    const list = vi.spyOn(tracker, "list").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.useFakeTimers();
    const sync = factory.core.syncTickets(project.id);
    const rejected = expect(sync).rejects.toThrow("tracker timed out");
    await vi.advanceTimersByTimeAsync(0);
    expect(await factory.core.listTickets(project.id)).toEqual([ticket]);
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
    finish([{ ...ticket, title: "late" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await factory.core.getTicket(project.id, ticket.id)).toEqual(ticket);
    list.mockResolvedValue([{ ...ticket, title: "fresh" }]);
    await factory.core.syncTickets(project.id);
    expect(await factory.core.getTicket(project.id, ticket.id)).toEqual({
      ...ticket,
      title: "fresh",
    });
    const snapshot = (await factory.core.listTickets(project.id))[0]!;
    snapshot.labels.push("local mutation");
    expect((await factory.core.getTicket(project.id, ticket.id))?.labels).toEqual(["cached"]);
    expect(await factory.core.getTicket(project.id, "missing")).toBeNull();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await factory.stop();
  }
});

test("ownership loss cancels sync before any snapshot writes", async () => {
  const factory = await createFactory({
    runtime: "fake",
    dataDir: mkdtempSync(join(tmpdir(), "matrix-sync-owner-")),
    host: "test",
    log: () => {},
  });
  try {
    const project = await factory.core.createProject({
      name: "sync",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    });
    const tracker = await factory.core.ticketStore(project.id);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (tickets: Ticket[]) => void;
    vi.spyOn(tracker, "list").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          entered();
        }),
    );
    const writes = vi.spyOn(factory.store, "replaceIndexedTickets");
    const sync = factory.core.syncTickets(project.id);
    const rejected = expect(sync).rejects.toThrow("ownership lost");
    await started;
    await factory.stateOwner.close();
    await rejected;
    finish([]);
    await Promise.resolve();
    expect(writes).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await factory.stop();
  }
});

test("reconciler readiness publication shares the mutation lock", async () => {
  const factory = await createFactory({
    runtime: "fake",
    dataDir: mkdtempSync(join(tmpdir(), "matrix-ready-race-")),
    host: "test",
    log: () => {},
  });
  let release = () => {};
  try {
    const project = await factory.core.createProject({
      name: "ready",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    });
    const original = await factory.core.createTicket(project.id, {
      title: "Old",
      body: "",
      labels: [],
    });
    const tracker = await factory.core.ticketStore(project.id);
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(tracker, "ready").mockImplementation(
      () =>
        new Promise<Ticket[]>((resolve) => {
          release = () => resolve([{ ...original, status: "ready" }]);
          entered();
        }),
    );
    vi.spyOn(factory.core, "projectDispatchAllowed")
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const lock = vi.spyOn(factory.core, "withTicketSnapshotLock");
    const tick = factory.reconciler.tick();
    await started;
    const mutation = factory.core.updateTicket(project.id, original.id, { title: "New" });
    await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(2));
    expect((await tracker.get(original.id))?.title).toBe("Old");
    release();
    await tick;
    const updated = await mutation;
    expect(await factory.core.getTicket(project.id, original.id)).toEqual(updated);
    expect(updated.title).toBe("New");
  } finally {
    release();
    vi.restoreAllMocks();
    await factory.stop();
  }
});

test("tracker deadlines abort executors even if they never settle", async () => {
  vi.useFakeTimers();
  try {
    let signal!: AbortSignal;
    const pending = trackerDeadline(
      async (received) => {
        signal = received;
        return new Promise<never>(() => {});
      },
      undefined,
      50,
    );
    const rejected = expect(pending).rejects.toThrow("tracker timed out");
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    expect(signal.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
