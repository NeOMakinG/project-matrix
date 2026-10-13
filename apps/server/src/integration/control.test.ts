import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleAnswers } from "@matrix/packs";
import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "../http/app.js";
import { createFactory, type Factory } from "./factory.js";
import { finalizeProject } from "./finalize.js";
import type { StoredProject } from "./mapping.js";

let factory: Factory | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await factory?.stop();
  factory = undefined;
});

async function boot() {
  factory = await createFactory({
    runtime: "fake",
    dataDir: mkdtempSync(join(tmpdir(), "matrix-control-")),
    host: "test",
    log: () => undefined,
  });
  const server = createServer({ core: factory.core, stateDir: factory.stateOwner.directory });
  const { token, key } = server.keys.create({
    name: "control-human",
    kind: "human",
    scope: { projects: "*", actions: ["admin"] },
  });
  const call = (method: string, path: string, body?: unknown, headers = {}) =>
    server.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const project = (await (
    await call("POST", "/v1/projects", {
      name: "control-fixture",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    })
  ).json()) as { id: string };
  return { call, project, server, key };
}

test("same-value human save changes ETag; stale autonomous PUT is 412 with no partial history", async () => {
  const { call, project, key } = await boot();
  const path = `/v1/projects/${project.id}`;
  const stale = (await call("GET", path)).headers.get("etag")!;
  const saved = await call(
    "PUT",
    `${path}/autonomy-policy`,
    { autonomy: { merge: "human" } },
    { "if-match": stale },
  );
  expect(saved.status).toBe(200);
  expect(saved.headers.get("etag")).not.toBe(stale);
  expect(
    (
      await call(
        "PUT",
        `${path}/autonomy-policy`,
        { autonomy: { merge: "autonomous" } },
        { "if-match": stale },
      )
    ).status,
  ).toBe(412);
  expect(await factory!.store.autonomyHistory(project.id)).toMatchObject([
    { phase: "merge", mode: "human", actor: `key:${key.id}` },
  ]);
  expect(
    (await call("PUT", `${path}/autonomy`, { phase: "deploy", mode: "human", actor: "forged" }))
      .status,
  ).toBe(200);
  expect((await factory!.store.autonomyHistory(project.id)).at(-1)?.actor).toBe(`key:${key.id}`);
});

test("history change between ETag check and Store write fails transactional CAS", async () => {
  const { call, project } = await boot();
  const path = `/v1/projects/${project.id}`;
  const etag = (await call("GET", path)).headers.get("etag")!;
  const store = factory!.store;
  const original = store.setAutonomyPolicy.bind(store);
  vi.spyOn(store, "setAutonomyPolicy").mockImplementationOnce(async (...args) => {
    await original(project.id, { merge: "human" }, "external-human");
    return original(...args);
  });
  expect(
    (
      await call(
        "PUT",
        `${path}/autonomy-policy`,
        { autonomy: { merge: "autonomous" } },
        { "if-match": etag },
      )
    ).status,
  ).toBe(412);
  expect(await store.autonomyHistory(project.id)).toHaveLength(1);
  expect((await store.getProjectPolicy(project.id)).project.autonomy.merge).toBe("human");
});

test("finalized effective policy answers drive preview; another interview cannot inherit the journal", async () => {
  const { call, project } = await boot();
  const session = (await (await call("POST", `/v1/projects/${project.id}/init`)).json()) as {
    id: string;
  };
  await call("POST", `/v1/init/${session.id}/answers`, {
    answers: {
      ...sampleAnswers,
      "process.autonomy.merge": "autonomous",
      "process.autonomy.deploy": "autonomous",
    },
  });
  const etag = (await call("GET", `/v1/projects/${project.id}`)).headers.get("etag")!;
  await call(
    "PUT",
    `/v1/projects/${project.id}/autonomy-policy`,
    { autonomy: { merge: "human", deploy: "human" } },
    { "if-match": etag },
  );
  const finished = (await (
    await call("POST", `/v1/init/${session.id}/finalize`, { acceptRecommended: true })
  ).json()) as { answers: Record<string, unknown>; result: { status: string; commit: string } };
  expect(finished.result.status).toBe("ok");
  expect(finished.answers).toMatchObject({
    "process.autonomy.merge": "human",
    "process.autonomy.deploy": "human",
  });
  const progress = (await (await call("GET", `/v1/init/${session.id}/progress`)).json()) as {
    configPreview: string;
    adrs: { title: string }[];
  };
  expect(progress.configPreview).toContain('"merge": "human"');
  expect(progress.adrs.some((adr) => adr.title.includes("Human approves"))).toBe(true);
  const other = (await (await call("POST", `/v1/projects/${project.id}/init`)).json()) as {
    id: string;
  };
  await call("POST", `/v1/init/${other.id}/answers`, { answers: finished.answers });
  const refused = (await (
    await call("POST", `/v1/init/${other.id}/finalize`, { acceptRecommended: true })
  ).json()) as { state: string; result: { status: string } };
  expect(refused).toMatchObject({ state: "in_progress", result: { status: "invalid" } });
  const repo = (await factory!.store.getProject(project.id))!.repoPath;
  const journal = JSON.parse(readFileSync(`${repo}.init.json`, "utf8"));
  expect(journal.sessionId).toBe(session.id);
  expect(journal.completed.result.commit).toBe(finished.result.commit);
  const changedInput = await finalizeProject({
    stateOwner: factory!.stateOwner,
    sessionId: session.id,
    completedCommit: finished.result.commit,
    project: (await factory!.store.getProject(project.id)) as StoredProject,
    answers: { ...finished.answers, "control.invalid-input": true },
    acceptRecommended: true,
    store: factory!.store,
    tickets: await factory!.core.ticketStore(project.id),
    journalFile: `${repo}.init.json`,
  });
  expect(changedInput.result.status).toBe("invalid");
  expect(JSON.parse(readFileSync(`${repo}.init.json`, "utf8"))).toEqual(journal);
}, 60_000);
