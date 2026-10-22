import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowState } from "@matrix/core";
import { fakeLinear } from "@matrix/tickets/testing/linear-fake";
import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "../http/app.js";
import { createFactory } from "./factory.js";

const KEY = `lin_api_${"y".repeat(16)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function boot() {
  const fake = fakeLinear();
  vi.stubGlobal("fetch", fake.fetch);
  vi.stubEnv("MATRIX_TEST_LINEAR_KEY", KEY);
  const dataDir = mkdtempSync(join(tmpdir(), "matrix-linear-project-"));
  const factory = await createFactory({ runtime: "fake", dataDir, host: "test", log: () => {} });
  const server = createServer({ core: factory.core, stateDir: dataDir });
  const { token } = server.keys.create({
    name: "linear",
    scope: { projects: "*", actions: ["admin"] },
  });
  const call = (method: string, path: string, body?: unknown) =>
    server.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { fake, factory, call };
}

const linear = {
  teamKey: "NEO",
  projectLabel: "project:demo",
  apiKeyEnv: "MATRIX_TEST_LINEAR_KEY",
};

test("create-project accepts linear by env var name only", async () => {
  const { factory, call } = await boot();
  try {
    const bad = [
      { kind: "linear" },
      { kind: "beads", linear },
      { kind: "linear", linear: { ...linear, apiKey: KEY } },
      { kind: "linear", linear: { ...linear, apiKeyEnv: "MATRIX_GATEWAY_KEY" } },
      { kind: "linear", linear: { ...linear, apiKeyEnv: KEY } },
      { kind: "linear", linear: { ...linear, teamKey: "neo" } },
    ];
    for (const tickets of bad)
      expect((await call("POST", "/v1/projects", { name: "x", tickets })).status).toBe(400);
    const ok = await call("POST", "/v1/projects", {
      name: "demo",
      workspace: "native",
      tickets: { kind: "linear", linear },
    });
    expect(ok.status).toBe(200);
    const { id } = (await ok.json()) as { id: string };
    const stored = await factory.store.getProject(id);
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect((stored as { matrix?: { tickets?: unknown } }).matrix?.tickets).toEqual({
      kind: "linear",
      linear,
    });
  } finally {
    await factory.stop();
  }
});

test("first sync creates the project label; workflow changes reach the board; failures are listed", async () => {
  const { fake, factory, call } = await boot();
  try {
    const created = await call("POST", "/v1/projects", {
      name: "demo",
      workspace: "native",
      tickets: { kind: "linear", linear },
    });
    const { id } = (await created.json()) as { id: string };
    expect((await call("GET", `/v1/projects/${id}/tickets`)).status).toBe(200);
    expect(fake.calls.filter((c) => c.op === "MatrixLabelCreate")).toHaveLength(1);

    const ticket = await factory.core.createTicket(id, { title: "Board", body: "", labels: [] });
    const workflow: WorkflowState = {
      projectId: id,
      ticketId: ticket.id,
      phase: "spike",
      status: "running",
      attempt: 1,
      loops: 0,
      priority: 2,
      version: 1,
    };
    factory.bus.publish({ type: "workflow.changed", workflow });
    await factory.trackerSync.flush();
    expect(fake.issues.get(ticket.id)?.state.name).toBe("Spike");
    expect(fake.comments.size).toBe(1);
    expect((await factory.core.getTicket(id, ticket.id))?.status).toBe("in_progress");

    // A non-retryable GraphQL error (retries would only add real backoff time here).
    for (let i = 0; i < 40; i++)
      fake.queue.push({ status: 200, body: { data: null, errors: [{ message: "boom" }] } });
    factory.bus.publish({ type: "workflow.changed", workflow: { ...workflow, phase: "review" } });
    await factory.trackerSync.flush();
    fake.queue.length = 0;
    const failures = (await (
      await call("GET", `/v1/projects/${id}/tracker/failures`)
    ).json()) as Array<{ operation: string; ticketId: string }>;
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toMatchObject({ ticketId: ticket.id });
    expect((await call("GET", "/v1/projects/nope/tracker/failures")).status).toBe(404);
  } finally {
    await factory.stop();
  }
});
