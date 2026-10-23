import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createServer } from "../http/app.js";
import { createFactory, type Factory } from "./factory.js";

let factory: Factory | undefined;
afterEach(async () => {
  await factory?.stop();
  factory = undefined;
});

async function boot() {
  factory = await createFactory({
    runtime: "fake",
    dataDir: mkdtempSync(join(tmpdir(), "matrix-cancel-")),
    host: "test",
    log: () => undefined,
  });
  const server = createServer({ core: factory.core, stateDir: factory.stateOwner.directory });
  const { token } = server.keys.create({
    name: "cancel-human",
    kind: "human",
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
  const project = (await (
    await call("POST", "/v1/projects", {
      name: "cancel-fixture",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    })
  ).json()) as { id: string };
  return { call, project, store: factory.store };
}

/** A workflow some (possibly remote) reconciler is running, with its run record. */
async function running(store: Factory["store"], projectId: string, ticketId: string) {
  const now = new Date();
  const runId = `run-${ticketId}`;
  await store.createRun({
    id: runId,
    projectId,
    ticketId,
    phase: "implement",
    attempt: 0,
    stepKey: `k-${ticketId}`,
    host: "elsewhere",
    ownerId: "reconciler:remote",
    status: "running",
    startedAt: now,
    lastEventAt: now,
    heartbeatAt: now,
  });
  await store.createWorkflow({
    projectId,
    ticketId,
    phase: "implement",
    status: "pending",
    attempt: 1,
    loops: 0,
    priority: 2,
    version: 0,
  });
  const w = await store.getWorkflow(projectId, ticketId);
  await store.saveWorkflow({
    ...(w as NonNullable<typeof w>),
    status: "running",
    currentRunId: runId,
    leaseOwner: "reconciler:remote",
    leaseExpiresAt: new Date(now.getTime() + 600_000),
  });
  return runId;
}

test("POST /v1/runs/{id}/cancel stops the run's workflow as a human stop", async () => {
  const { call, project, store } = await boot();
  const runId = await running(store, project.id, "T-1");
  const res = await call("POST", `/v1/runs/${runId}/cancel`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { state: string }).state).toBe("cancelled");
  const w = await store.getWorkflow(project.id, "T-1");
  expect(w).toMatchObject({ status: "blocked", attempt: 1 });
  expect(w?.lastError).toBe("stopped by human (cancelled via API)");
  expect(w?.leaseOwner).toBeUndefined();
  // A finished run cannot be cancelled again.
  expect((await call("POST", `/v1/runs/${runId}/cancel`)).status).toBe(409);
});

test("ticket and project cancel endpoints stop active workflows only", async () => {
  const { call, project, store } = await boot();
  await running(store, project.id, "T-1");
  await running(store, project.id, "T-2");
  const one = await call("POST", `/v1/projects/${project.id}/tickets/T-1/cancel`);
  expect(one.status).toBe(200);
  expect(await one.json()).toMatchObject({ ticketId: "T-1", stopped: true });
  const again = await call("POST", `/v1/projects/${project.id}/tickets/T-1/cancel`);
  expect(await again.json()).toMatchObject({ ticketId: "T-1", stopped: false });
  const all = await call("POST", `/v1/projects/${project.id}/cancel`);
  expect(all.status).toBe(200);
  expect(await all.json()).toEqual([expect.objectContaining({ ticketId: "T-2", stopped: true })]);
  expect((await store.getWorkflow(project.id, "T-2"))?.status).toBe("blocked");
  expect((await call("POST", "/v1/projects/nope/cancel")).status).toBe(404);
});
