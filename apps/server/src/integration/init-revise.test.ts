import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleAnswers } from "@matrix/packs";
import { afterEach, describe, expect, test } from "vitest";
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
    dataDir: mkdtempSync(join(tmpdir(), "matrix-rev-")),
    host: "test-host",
    log: () => undefined,
  });
  const server = createServer({ core: factory.core });
  const token = server.keys.create({
    name: "valentin",
    kind: "human",
    scope: { projects: "*", actions: ["admin"] },
  }).token;
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    server.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
  return { call, json };
}

const newProject = {
  name: "pilot",
  description: "",
  workspace: "native",
  tickets: { kind: "markdown" },
};

describe("init and project follow-ups", () => {
  test("revising an answer drops the answers that depended on it", async () => {
    const { call, json } = await boot();
    const project = await json<{ id: string }>(call("POST", "/v1/projects", newProject));
    const session = await json<{ id: string }>(call("POST", `/v1/projects/${project.id}/init`));
    await call("POST", `/v1/init/${session.id}/answers`, {
      answers: { ...sampleAnswers, "backend.kind": "node-api", "hosting.api": "fly" },
    });

    const revised = await json<{
      dropped: string[];
      session: { answers: Record<string, unknown> };
      progress: { round: { id: string }[] };
    }>(call("PATCH", `/v1/init/${session.id}/answers/backend.kind`, { value: "none" }));
    expect(revised.session.answers["backend.kind"]).toBe("none");
    // hosting.api depends on backend.kind and must be asked again
    expect(revised.dropped).toContain("hosting.api");
    for (const id of revised.dropped) expect(revised.session.answers[id]).toBeUndefined();
    expect(
      (await call("PATCH", `/v1/init/${session.id}/answers/not.a.question`, { value: "x" })).status,
    ).toBe(400);
  });

  test("finalize refuses with 409 and the list while contradictions remain", async () => {
    const { call, json } = await boot();
    const project = await json<{ id: string }>(call("POST", "/v1/projects", newProject));
    const session = await json<{ id: string }>(call("POST", `/v1/projects/${project.id}/init`));
    await call("POST", `/v1/init/${session.id}/answers`, {
      answers: { ...sampleAnswers, "backend.database": "none", "backend.orm": "drizzle" },
    });
    const refused = await call("POST", `/v1/init/${session.id}/finalize`, {
      acceptRecommended: true,
    });
    expect(refused.status).toBe(409);
    const body = await json<{ error: { code: string; details: { id: string }[] } }>(refused);
    expect(body.error.code).toBe("contradictions");
    expect(body.error.details.map((d) => d.id)).toContain("orm-without-database");
  });

  test("Idempotency-Key makes project creation and init start safe to retry", async () => {
    const { call, json } = await boot();
    const create = () =>
      call("POST", "/v1/projects", newProject, { "idempotency-key": "create-pilot-0001" });
    const a = await json<{ id: string }>(create());
    const b = await json<{ id: string }>(create());
    expect(b.id).toBe(a.id);
    expect(await json<unknown[]>(call("GET", "/v1/projects"))).toHaveLength(1);

    const start = () =>
      call("POST", `/v1/projects/${a.id}/init`, undefined, {
        "idempotency-key": "init-pilot-0001",
      });
    expect((await json<{ id: string }>(start())).id).toBe((await json<{ id: string }>(start())).id);
  });

  test("autonomy for several phases in one atomic write, guarded by If-Match", async () => {
    const { call, json } = await boot();
    const project = await json<{ id: string }>(call("POST", "/v1/projects", newProject));
    const loaded = await call("GET", `/v1/projects/${project.id}`);
    const etag = loaded.headers.get("etag") ?? "";
    const policy = { autonomy: { merge: "gated", deploy: "human", review: "autonomous" } };
    const put = (headers: Record<string, string>) =>
      call("PUT", `/v1/projects/${project.id}/autonomy-policy`, policy, headers);

    expect((await put({})).status).toBe(428);
    const saved = await put({ "if-match": etag });
    expect(saved.status).toBe(200);
    expect((await json<{ autonomy: Record<string, string> }>(saved)).autonomy).toMatchObject({
      merge: "gated",
      deploy: "human",
      review: "autonomous",
    });
    expect((await put({ "if-match": etag })).status).toBe(412);
  });
});
