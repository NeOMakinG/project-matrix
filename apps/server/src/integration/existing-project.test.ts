import { mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "../http/app.js";
import { makeRepo } from "./existing-repo.test-helpers.js";
import { createFactory } from "./factory.js";
import type { StoredProject } from "./mapping.js";

afterEach(() => vi.unstubAllGlobals());

const linear = { teamKey: "NEO", projectLabel: "project:wayline", apiKeyEnv: "LINEAR_API_KEY" };

async function boot(models?: string[]) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "matrix-existing-project-")));
  const root = join(base, "Projects");
  mkdirSync(root);
  const repo = makeRepo(root, "wayline", {
    "package.json": JSON.stringify({
      scripts: { typecheck: "tsc", lint: "biome", test: "vitest" },
    }),
    "pnpm-lock.yaml": "",
  });
  const dataDir = join(base, "data");
  const factory = await createFactory({
    runtime: "fake",
    dataDir,
    host: "test",
    log: () => {},
    repoRoots: [root],
    ...(models ? { gateway: { baseUrl: "http://gateway.test/v1", apiKey: "k" } } : {}),
  });
  if (models)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: models.map((id) => ({ id })) })),
    );
  const server = createServer({ core: factory.core, stateDir: dataDir });
  const { token } = server.keys.create({
    name: "op",
    scope: { projects: "*", actions: ["admin"] },
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await server.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { root, repo, dataDir, factory, call };
}

test("registers an existing repo host-side, with Linear, detected checks and a model plan", async () => {
  const { repo, factory, call } = await boot();
  const before = readdirSync(repo).sort();
  const created = await call("POST", "/v1/projects", {
    name: "Travel Journal",
    repo: { path: repo, baseBranch: "main" },
    tickets: { kind: "linear", linear },
    models: {
      implement: { runner: "claude-code", model: "claude-opus-5-5" },
      review: { runner: "codex", model: "gpt-6-sol" },
    },
  });
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({
    repo: { external: true, baseBranch: "main", remote: "origin", github: "acme/wayline" },
    models: { implement: { model: "claude-opus-5-5" }, review: { model: "gpt-6-sol" } },
    checks: [
      { kind: "typecheck", cmd: ["pnpm", "run", "typecheck"] },
      { kind: "lint", cmd: ["pnpm", "run", "lint"] },
      { kind: "test", cmd: ["pnpm", "run", "test"] },
    ],
  });
  expect(readdirSync(repo).sort()).toEqual(before);
  const id = String(created.body.id);
  const stored = (await factory.store.getProject(id)) as StoredProject;
  expect(stored).toMatchObject({ repoPath: repo, baseBranch: "main", lastPhase: "merge" });
  expect(stored.models.tiers).toBeUndefined();
  expect(stored.matrix?.repo?.editablePaths).toEqual(["package.json", "pnpm-lock.yaml"]);
  const paths = await call("PATCH", `/v1/projects/${id}`, {
    repo: { editablePaths: ["app", "docs", "designs"] },
  });
  expect(paths.body).toMatchObject({ repo: { editablePaths: ["app", "docs", "designs"] } });
  expect(
    (await call("PATCH", `/v1/projects/${id}`, { repo: { editablePaths: [".github/workflows"] } }))
      .status,
  ).toBe(400);

  expect((await call("POST", `/v1/projects/${id}/init`)).status).toBe(409);
  const again = await call("POST", "/v1/projects", {
    name: "dup",
    repo: { path: repo },
    tickets: { kind: "linear", linear },
  });
  expect(again.status).toBe(409);

  const updated = await call("PATCH", `/v1/projects/${id}`, {
    checks: [{ kind: "test", cmd: ["pnpm", "test", "--", "--run"] }],
    models: { qa: { runner: "codex", model: "gpt-6.1-sol" } },
    tickets: { kind: "linear", linear: { ...linear, projectLabel: "project:tj" } },
  });
  expect(updated.status).toBe(200);
  expect(updated.body).toMatchObject({
    checks: [{ kind: "test", cmd: ["pnpm", "test", "--", "--run"] }],
    models: { qa: { model: "gpt-6.1-sol" } },
  });
  const patched = (await factory.store.getProject(id)) as StoredProject;
  expect(patched.matrix?.tickets.linear?.projectLabel).toBe("project:tj");
  await factory.stop();
});

test("rejects unsafe registrations and non-independent review", async () => {
  const { root, call, factory } = await boot();
  const repo = makeRepo(root, "app2");
  const post = (body: Record<string, unknown>) =>
    call("POST", "/v1/projects", { name: "x", tickets: { kind: "linear", linear }, ...body });
  expect((await post({ repo: { path: "/etc" } })).status).toBe(400);
  expect((await post({ repo: { path: "relative" } })).status).toBe(400);
  expect((await post({ repo: { path: repo, baseBranch: "nope" } })).status).toBe(400);
  expect((await post({ repo: { path: repo, remote: "--upload-pack=x" } })).status).toBe(400);
  expect(
    (
      await call("POST", "/v1/projects", {
        name: "x",
        repo: { path: repo },
        tickets: { kind: "beads" },
      })
    ).status,
  ).toBe(400);
  const same = await post({
    repo: { path: repo },
    models: {
      implement: { runner: "claude-code", model: "m1" },
      review: { runner: "codex", model: "m1" },
    },
  });
  expect(same.status).toBe(400);
  expect(JSON.stringify(same.body)).toMatch(/independent review/);
  await factory.stop();
});

test("model ids are checked against the gateway when it answers", async () => {
  const { repo, call, factory } = await boot(["claude-opus-5-5", "gpt-6-sol"]);
  const bad = await call("POST", "/v1/projects", {
    name: "x",
    repo: { path: repo },
    tickets: { kind: "linear", linear },
    models: { review: { runner: "codex", model: "gpt-9-imaginary" } },
  });
  expect(bad.status).toBe(400);
  expect(JSON.stringify(bad.body)).toMatch(/gpt-9-imaginary/);
  await factory.stop();
});
