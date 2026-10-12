import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleAnswers } from "@matrix/packs";
import type { NewTicket, Ticket, TicketPatch, TicketStore } from "@matrix/tickets";
import { MarkdownTicketStore } from "@matrix/tickets/adapters/markdown";
import { expect, test, vi } from "vitest";
import { createServer } from "../http/app.js";
import { createFactory } from "./factory.js";
import { mirrorBacklog, type TrackerJournal } from "./finalize-tracker.js";

class FixtureTracker implements TicketStore {
  readonly kind = "github";
  readonly records = new Map<string, Ticket>();
  failAfterCreate = false;
  async list() {
    return [...this.records.values()].map((ticket) => structuredClone(ticket));
  }
  async get(id: string) {
    return this.records.get(id) ?? null;
  }
  async create(input: NewTicket) {
    const ticket: Ticket = {
      title: input.title,
      body: input.body,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.parent === undefined ? {} : { parent: input.parent }),
      id: `actual-${this.records.size + 1}`,
      status: "open",
      labels: input.labels ?? [],
      deps: input.deps ?? [],
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
    };
    this.records.set(ticket.id, ticket);
    if (this.failAfterCreate) {
      this.failAfterCreate = false;
      throw new Error("simulated response lost after durable create");
    }
    return ticket;
  }
  async update(id: string, patch: TicketPatch) {
    const ticket = this.records.get(id);
    if (!ticket) throw new Error("fixture ticket not found");
    const updated = { ...ticket, ...patch };
    this.records.set(id, updated);
    return updated;
  }
  async comment() {}
  async link() {}
  async ready() {
    return [];
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "matrix-tracker-fixture-"));
  const markdown = new MarkdownTicketStore(join(directory, ".matrix/tickets"), { root: directory });
  const parent = await markdown.create({ title: "same title", body: "parent fixture" });
  const child = await markdown.create({
    title: "child fixture",
    body: "child fixture",
    parent: parent.id,
    deps: [parent.id],
  });
  const files: Record<string, string> = {};
  const load = async (path: string) => {
    for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) await load(name);
      else files[name] = await readFile(join(directory, name), "utf8");
    }
  };
  await load(".matrix/tickets");
  files[".matrix/graph/product.json"] = JSON.stringify({
    version: 1,
    nodes: [
      { id: `ticket:${child.id}`, kind: "ticket", label: child.title },
      { id: "feature:fixture", kind: "feature", label: "fixture" },
    ],
    edges: [{ from: `ticket:${child.id}`, to: "feature:fixture", kind: "implements" }],
  });
  const tracker = new FixtureTracker();
  await tracker.create({
    title: "same title",
    body: "unrelated existing ticket; not an init marker",
  });
  let persisted: TrackerJournal = { files };
  const mirror = async (journal: TrackerJournal) =>
    mirrorBacklog({
      projectId: "fixture-project",
      sessionId: "fixture-session",
      journal,
      tickets: tracker,
      save: () => {
        persisted = JSON.parse(JSON.stringify(journal));
      },
    });
  return {
    tracker,
    parent,
    child,
    mirror,
    journal: { files },
    restart: () => JSON.parse(JSON.stringify(persisted)) as TrackerJournal,
  };
}

test("mirror uses durable markdown→actual IDs, preserves parent/deps and rewrites graph before publication", async () => {
  const { tracker, parent, child, journal, mirror, restart } = await fixture();
  const ids = await mirror(journal);
  const saved = restart();
  const actualParent = saved.ticketMap![parent.id]!;
  const actualChild = saved.ticketMap![child.id]!;
  expect(actualParent).not.toBe("actual-1");
  expect(await tracker.get(actualChild)).toMatchObject({
    parent: actualParent,
    deps: [actualParent],
  });
  const graph = JSON.parse(saved.files[".matrix/graph/product.json"]!);
  expect(graph.nodes).toContainEqual({
    id: `ticket:${actualChild}`,
    kind: "ticket",
    label: child.title,
  });
  expect(graph.edges[0].from).toBe(`ticket:${actualChild}`);
  expect(await mirror(saved)).toEqual(ids);
  expect(await tracker.list()).toHaveLength(3);
});

test("response-loss retry recovers persisted marker, not title, after an independent journal reload", async () => {
  const { tracker, journal, mirror, restart } = await fixture();
  tracker.failAfterCreate = true;
  await expect(mirror(journal)).rejects.toThrow("response lost");
  expect(await tracker.list()).toHaveLength(2);
  await mirror(restart());
  expect(await tracker.list()).toHaveLength(3);
  expect(Object.keys(restart().ticketMap!)).toHaveLength(2);
});

test("uncertain create with no recoverable marker refuses retry instead of duplicating", async () => {
  const { tracker, journal, mirror, restart } = await fixture();
  tracker.failAfterCreate = true;
  await expect(mirror(journal)).rejects.toThrow();
  tracker.records.delete("actual-2");
  await expect(mirror(restart())).rejects.toThrow("ambiguous tracker create");
  expect(await tracker.list()).toHaveLength(1);
});

test("actual finalize API publishes remapped graph and preserves tracker IDs on durable retry", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "matrix-tracker-api-"));
  const factory = await createFactory({ runtime: "fake", dataDir, host: "test", log: () => {} });
  const tracker = new FixtureTracker();
  const adapter = vi.spyOn(factory.core, "ticketStore").mockResolvedValue(tracker);
  const server = createServer({ core: factory.core, stateDir: dataDir });
  try {
    const { token } = server.keys.create({
      name: "tracker-fixture",
      scope: { projects: "*", actions: ["admin"] },
    });
    const call = (path: string, body: unknown) =>
      server.app.request(path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const created = await call("/v1/projects", {
      name: "tracker-fixture",
      description: "",
      workspace: "native",
      tickets: { kind: "github", repo: "fixture/not-a-real-repo" },
    });
    expect(created.status).toBe(200);
    const project = (await created.json()) as { id: string };
    const session = (await (await call(`/v1/projects/${project.id}/init`, {})).json()) as {
      id: string;
    };
    expect(
      (
        await call(`/v1/init/${session.id}/answers`, {
          answers: { ...sampleAnswers, "process.tickets": "github" },
        })
      ).status,
    ).toBe(200);
    const response = await call(`/v1/init/${session.id}/finalize`, { acceptRecommended: true });
    expect(response.status).toBe(200);
    const finished = (await response.json()) as {
      result: { status: string; tickets: string[]; commit: string };
    };
    expect(finished.result.status).toBe("ok");
    expect(finished.result.tickets.length).toBeGreaterThan(0);
    expect(finished.result.tickets.every((id) => id.startsWith("actual-"))).toBe(true);
    const repo = (await factory.store.getProject(project.id))!.repoPath;
    const graph = JSON.parse(await readFile(join(repo, ".matrix/graph/product.json"), "utf8")) as {
      nodes: { id: string; kind: string }[];
      edges: { from: string; to: string }[];
    };
    const ticketNodes = graph.nodes.filter((node) => node.kind === "ticket");
    expect(ticketNodes.length).toBeGreaterThan(0);
    expect(ticketNodes.every((node) => finished.result.tickets.includes(node.id.slice(7)))).toBe(
      true,
    );
    for (const edge of graph.edges)
      for (const id of [edge.from, edge.to])
        if (id.startsWith("ticket:")) expect(finished.result.tickets).toContain(id.slice(7));
    const count = (await tracker.list()).length;
    const retried = await call(`/v1/init/${session.id}/finalize`, { acceptRecommended: true });
    expect(await retried.json()).toMatchObject({ result: finished.result });
    expect(await tracker.list()).toHaveLength(count);
    const journal = JSON.parse(await readFile(`${repo}.init.json`, "utf8")) as TrackerJournal;
    expect(Object.values(journal.ticketMap!)).toEqual(finished.result.tickets);
    expect(journal.files[".matrix/graph/product.json"]).toBe(
      await readFile(join(repo, ".matrix/graph/product.json"), "utf8"),
    );
    const snapshot = await factory.store.getProjectPolicy(project.id);
    await factory.store.setAutonomyPolicy(
      project.id,
      { merge: "human", deploy: "human" },
      "external-human",
      snapshot.version,
    );
    const rebased = await call(`/v1/init/${session.id}/finalize`, { acceptRecommended: true });
    expect(rebased.status).toBe(200);
    expect(await rebased.json()).toMatchObject({
      result: { status: "ok", tickets: finished.result.tickets },
      answers: { "process.autonomy.merge": "human", "process.autonomy.deploy": "human" },
    });
    expect(await tracker.list()).toHaveLength(count);
    const updatedJournal = JSON.parse(await readFile(`${repo}.init.json`, "utf8"));
    expect(updatedJournal.ticketMap).toEqual(journal.ticketMap);
    const regenerated = JSON.parse(
      await readFile(join(repo, ".matrix/graph/product.json"), "utf8"),
    );
    expect(regenerated.nodes.filter((node: { kind: string }) => node.kind === "ticket")).toEqual(
      ticketNodes,
    );
  } finally {
    adapter.mockRestore();
    await server.close();
    await factory.stop();
  }
}, 60_000);
