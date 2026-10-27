import type { Store } from "@matrix/core";
import { EventBus } from "@matrix/core";
import type { Ticket } from "@matrix/tickets";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type DeckConfig, DeckLifecycle } from "./deck-lifecycle.js";
import type { StoredProject } from "./mapping.js";

// Minimal Store mock
function makeStore(label?: string, ticket?: Partial<Ticket>): Store {
  const project = (label
    ? {
        id: "proj1",
        matrix: {
          tickets: { kind: "linear", linear: { teamKey: "NEO", projectLabel: label } },
          description: "",
          workspace: "orca",
          createdAt: "",
        },
      }
    : { id: "proj1" }) as unknown as StoredProject;
  return {
    getProject: vi.fn().mockResolvedValue(project),
    getIndexedTicket: vi.fn().mockResolvedValue(
      ticket
        ? {
            id: "ticket1",
            title: ticket.title ?? "Test ticket",
            body: "",
            status: "in_progress" as const,
            labels: [],
            deps: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            url: ticket.url,
          }
        : null,
    ),
    getIndexedTicketTitle: vi.fn().mockResolvedValue(ticket?.title ?? null),
  } as unknown as Store;
}

function makeDecks(): { decks: Map<string, DeckConfig>; repoToDeck: Map<string, string> } {
  const decks = new Map<string, DeckConfig>([
    ["tj", { name: "tj", url: "https://deck.example.com/v1", key: "test-key-tj" }],
    ["delta", { name: "delta", url: "https://deck.example.com/v1", key: "test-key-delta" }],
  ]);
  const repoToDeck = new Map<string, string>([
    ["project:travel-journal", "tj"],
    ["project:eagleray", "delta"],
  ]);
  return { decks, repoToDeck };
}

describe("DeckLifecycle", () => {
  test("ticket pickup creates deck task when no existing task", async () => {
    const fetchMock = vi.fn();
    const bus = new EventBus();
    const store = makeStore("project:travel-journal", {
      title: "Add dark mode",
      url: "https://linear.app/issue/1",
    });
    const { decks, repoToDeck } = makeDecks();
    const logs: string[] = [];

    // GET /tasks (search) → empty list
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ tasks: [] }),
    });
    // POST /tasks → created task
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: "deck-task-42" }),
    });

    const lifecycle = new DeckLifecycle({
      bus,
      store,
      decks,
      repoToDeck,
      log: (m) => logs.push(m),
      fetch: fetchMock,
    });
    lifecycle.start();

    bus.publish({
      type: "run.started",
      runId: "run1",
      projectId: "proj1",
      ticketId: "ticket1",
      phase: "spike",
    });

    // Wait for async handlers
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const searchCall = fetchMock.mock.calls[0]!;
    const createCall = fetchMock.mock.calls[1]!;
    expect(searchCall[0]).toContain("/tasks?q=");
    expect(createCall[0]).toContain("/tasks");
    expect(createCall[1].method).toBe("POST");
    const body = JSON.parse(createCall[1].body as string);
    expect(body.title).toBe("Add dark mode");
    expect(body.status).toBe("in_progress");
    expect(body.description).toContain("linearId:ticket1");
    expect(logs.some((l) => l.includes("deck-task-42"))).toBe(true);

    lifecycle.stop();
  });

  test("ticket pickup dedupes: posts note if existing open task found", async () => {
    const fetchMock = vi.fn();
    const bus = new EventBus();
    const store = makeStore("project:travel-journal", { title: "Add dark mode" });
    const { decks, repoToDeck } = makeDecks();
    const logs: string[] = [];

    // GET /tasks → existing task
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ tasks: [{ id: "existing-99", status: "in_progress" }] }),
    });
    // POST /activities → ok
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    const lifecycle = new DeckLifecycle({
      bus,
      store,
      decks,
      repoToDeck,
      log: (m) => logs.push(m),
      fetch: fetchMock,
    });
    lifecycle.start();

    bus.publish({
      type: "run.started",
      runId: "run2",
      projectId: "proj1",
      ticketId: "ticket1",
      phase: "spike",
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const activityCall = fetchMock.mock.calls[1]!;
    expect(activityCall[0]).toContain("/activities");
    const body = JSON.parse(activityCall[1].body as string);
    expect(body.summary).toContain("Matrix picked up ticket");

    lifecycle.stop();
  });

  test("PR opened posts activity note", async () => {
    const fetchMock = vi.fn();
    const bus = new EventBus();
    const store = makeStore("project:travel-journal", { title: "PR test" });
    const { decks, repoToDeck } = makeDecks();

    // Spike pickup: search + create
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ tasks: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: "task-pr" }),
      })
      // PR activity
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

    const lifecycle = new DeckLifecycle({ bus, store, decks, repoToDeck, fetch: fetchMock });
    lifecycle.start();

    bus.publish({
      type: "run.started",
      runId: "run3",
      projectId: "proj1",
      ticketId: "ticket2",
      phase: "spike",
    });
    await new Promise((r) => setTimeout(r, 50));

    bus.publish({
      type: "pull_request.opened",
      projectId: "proj1",
      ticketId: "ticket2",
      url: "https://github.com/pr/1",
      branch: "feat/ticket2",
    });
    await new Promise((r) => setTimeout(r, 50));

    const prCall = fetchMock.mock.calls[2]!;
    expect(prCall[0]).toContain("/activities");
    const body = JSON.parse(prCall[1].body as string);
    expect(body.summary).toContain("PR opened");
    expect(body.summary).toContain("https://github.com/pr/1");
    expect(body.entityId).toBe("task-pr");

    lifecycle.stop();
  });

  test("workflow done patches task status to done", async () => {
    const fetchMock = vi.fn();
    const bus = new EventBus();
    const store = makeStore("project:travel-journal", { title: "Done test" });
    const { decks, repoToDeck } = makeDecks();

    // Spike: search + create
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ tasks: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: "task-done" }),
      })
      // PATCH done
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

    const lifecycle = new DeckLifecycle({ bus, store, decks, repoToDeck, fetch: fetchMock });
    lifecycle.start();

    bus.publish({
      type: "run.started",
      runId: "run4",
      projectId: "proj1",
      ticketId: "ticket3",
      phase: "spike",
    });
    await new Promise((r) => setTimeout(r, 50));

    bus.publish({
      type: "workflow.changed",
      workflow: {
        projectId: "proj1",
        ticketId: "ticket3",
        phase: "qa",
        status: "done",
        attempt: 1,
        loops: 1,
        priority: 0,
        version: 1,
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    const patchCall = fetchMock.mock.calls[2]!;
    expect(patchCall[0]).toContain("/tasks/task-done");
    expect(patchCall[1].method).toBe("PATCH");
    const body = JSON.parse(patchCall[1].body as string);
    expect(body.status).toBe("done");

    lifecycle.stop();
  });

  test("429 retry with backoff", async () => {
    const fetchMock = vi.fn();
    const bus = new EventBus();
    const store = makeStore("project:travel-journal", { title: "Retry test" });
    const { decks, repoToDeck } = makeDecks();

    // Search → 429 twice, then 200 empty
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tasks: [] }) })
      // POST /tasks
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: "task-retry" }) });

    // Use 0ms delays so the test doesn't need fake timers
    const lifecycle = new DeckLifecycle({
      bus,
      store,
      decks,
      repoToDeck,
      fetch: fetchMock,
      retryDelays: [0, 0, 0],
    });
    lifecycle.start();

    bus.publish({
      type: "run.started",
      runId: "run5",
      projectId: "proj1",
      ticketId: "ticket4",
      phase: "spike",
    });

    // Wait for all retries (0ms each) to complete
    await new Promise((r) => setTimeout(r, 100));

    // Should have retried and eventually created
    expect(fetchMock).toHaveBeenCalledTimes(4);

    lifecycle.stop();
  });
});
