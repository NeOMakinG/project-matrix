import { mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeLinear } from "@matrix/tickets/testing/linear-fake";
import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "../http/app.js";
import { makeRepo } from "./existing-repo.test-helpers.js";
import { createFactory } from "./factory.js";
import type { StoredProject } from "./mapping.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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
  expect(stored.matrix?.repo?.editablePaths).toEqual([
    "README.md",
    "package.json",
    "pnpm-lock.yaml",
  ]);
  const paths = await call("PATCH", `/v1/projects/${id}`, {
    repo: { editablePaths: ["app", "docs", "designs"] },
  });
  expect(paths.body).toMatchObject({ repo: { editablePaths: ["app", "docs", "designs"] } });
  expect(
    (await call("PATCH", `/v1/projects/${id}`, { repo: { editablePaths: [".github/workflows"] } }))
      .status,
  ).toBe(400);

  expect(paths.body).toMatchObject({ repo: { setupScripts: false } });
  expect((paths.body as { repo: { setup?: unknown } }).repo.setup).toBeUndefined();
  const setup = [{ cwd: "app", run: ["npm", "ci", "--no-audit", "--no-fund", "--ignore-scripts"] }];
  const withSetup = await call("PATCH", `/v1/projects/${id}`, { repo: { setup } });
  expect(withSetup.body).toMatchObject({
    repo: { setup, editablePaths: ["app", "docs", "designs"] },
  });
  expect(((await factory.store.getProject(id)) as StoredProject).matrix?.repo?.setup).toEqual(
    setup,
  );
  for (const bad of [[{ cwd: "../x", run: ["npm", "ci"] }], [{ run: [] }], [{ run: "npm ci" }]])
    expect((await call("PATCH", `/v1/projects/${id}`, { repo: { setup: bad } })).status).toBe(400);
  const reset = await call("PATCH", `/v1/projects/${id}`, {
    repo: { setup: null, setupScripts: true },
  });
  expect(reset.body).toMatchObject({ repo: { setupScripts: true } });
  expect(
    ((await factory.store.getProject(id)) as StoredProject).matrix?.repo?.setup,
  ).toBeUndefined();

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

test("an unreachable gateway model list is a clear 400, not a silent pass", async () => {
  const { repo, call, factory } = await boot(["gpt-6-sol"]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("down", { status: 502 })),
  );
  const res = await call("POST", "/v1/projects", {
    name: "x",
    repo: { path: repo },
    tickets: { kind: "linear", linear },
    models: { review: { runner: "codex", model: "gpt-6-sol" } },
  });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toMatch(/cannot verify model ids/);
  await factory.stop();
});

test("blocked-ticket labels reach Linear: the project ticket store forwards addLabel/removeLabel", async () => {
  const { repo, call, factory } = await boot();
  const created = await call("POST", "/v1/projects", {
    name: "Travel Journal",
    repo: { path: repo },
    tickets: { kind: "linear", linear },
  });
  expect(created.status).toBe(200);
  const fake = fakeLinear();
  vi.stubGlobal("fetch", fake.fetch);
  vi.stubEnv("LINEAR_API_KEY", `lin_api_${"x".repeat(16)}`);
  const core = factory.core as unknown as {
    ticketStore(id: string): Promise<import("@matrix/tickets").TicketStore>;
  };
  const store = await core.ticketStore(String(created.body.id));
  expect(store.addLabel).toBeTypeOf("function");
  expect(store.removeLabel).toBeTypeOf("function");
  expect(store.listComments).toBeTypeOf("function");
  expect(store.uploadFile).toBeTypeOf("function");
  const ticket = await store.create({ title: "Choose photos does nothing", body: "" });
  await store.addLabel?.(ticket.id, "needs-human");
  expect((await store.get(ticket.id))?.labels).toContain("needs-human");
  await store.removeLabel?.(ticket.id, "needs-human");
  expect((await store.get(ticket.id))?.labels).not.toContain("needs-human");
  await factory.stop();
});

test("PATCH accepts size tiers: gateway-served, strict and independent from review", async () => {
  const { repo, factory, call } = await boot(["claude-opus-4-7", "claude-sonnet-5-5", "gpt-6-sol"]);
  const created = await call("POST", "/v1/projects", {
    name: "Tiers",
    repo: { path: repo, baseBranch: "main" },
    tickets: { kind: "linear", linear },
  });
  expect(created.status).toBe(200);
  const id = String(created.body.id);
  const tier = (model: string) => ({ runner: "claude-code", model });
  const tiers = { large: tier("claude-opus-4-7"), small: tier("claude-sonnet-5-5") };
  const ok = await call("PATCH", `/v1/projects/${id}`, { models: { tiers } });
  expect(ok.status).toBe(200);
  expect(((await factory.store.getProject(id)) as StoredProject).models.tiers).toEqual(tiers);
  const patch = (models: unknown) => call("PATCH", `/v1/projects/${id}`, { models });
  const unserved = await patch({ tiers: { ...tiers, small: tier("claude-nope-1") } });
  expect(unserved.status).toBe(400);
  expect(JSON.stringify(unserved.body)).toContain("claude-nope-1");
  expect((await patch({ tiers: { large: tiers.large } })).status).toBe(400);
  expect((await patch({ tiers: { ...tiers, medium: tiers.large } })).status).toBe(400);
  // A tier is an implementer: it can never equal the review model.
  const review = ((await factory.store.getProject(id)) as StoredProject).models.review;
  const clash = await patch({ tiers: { ...tiers, small: review } });
  expect(clash.status).toBe(400);
  expect(JSON.stringify(clash.body)).toContain("independent review");
  // Setting implement and tiers together keeps the posted tiers.
  const both = await patch({ implement: tier("claude-opus-4-7"), tiers });
  expect(both.status).toBe(200);
  expect(((await factory.store.getProject(id)) as StoredProject).models.tiers).toEqual(tiers);
  await factory.stop();
});

test("sandbox resources, base warm-up and flaky retries: set, PATCHed, bounded, cleared", async () => {
  const { repo, factory, call } = await boot();
  const created = await call("POST", "/v1/projects", {
    name: "Resources",
    repo: { path: repo, baseBranch: "main" },
    tickets: { kind: "linear", linear },
    resources: { checks: { cpus: 8, memoryGb: 16 } },
    baselineWarmup: true,
    checks: [{ kind: "test", cmd: ["npm", "test"], parser: "node-test-tap", retryFlaky: false }],
  });
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({
    resources: { checks: { cpus: 8, memoryGb: 16 } },
    baselineWarmup: true,
    checks: [{ retryFlaky: false }],
  });
  const id = String(created.body.id);
  const patch = (body: unknown) => call("PATCH", `/v1/projects/${id}`, body);
  const ok = await patch({ resources: { implement: { cpus: 4 } }, baselineWarmup: false });
  expect(ok.status).toBe(200);
  const stored = (await factory.store.getProject(id)) as StoredProject;
  expect(stored.resources).toEqual({ implement: { cpus: 4 } });
  expect(stored.baselineWarmup).toBeUndefined();
  for (const bad of [
    { resources: { checks: { cpus: 0 } } },
    { resources: { checks: { cpus: 129 } } },
    { resources: { checks: { memoryGb: 1.5 } } },
    { resources: { checks: { memoryGb: 513 } } },
    { resources: { merge: { cpus: 2 } } },
    { resources: { checks: { disk: 2 } } },
  ])
    expect((await patch(bad)).status, JSON.stringify(bad)).toBe(400);
  expect((await patch({ resources: null })).status).toBe(200);
  expect(((await factory.store.getProject(id)) as StoredProject).resources).toBeUndefined();
  await factory.stop();
});

test("run timeouts and implement guidance: set at registration, PATCHed, bounded, cleared", async () => {
  const { repo, factory, call } = await boot();
  const min = 60_000;
  const created = await call("POST", "/v1/projects", {
    name: "Timeouts",
    repo: { path: repo, baseBranch: "main" },
    tickets: { kind: "linear", linear },
    timeouts: { checks: 45 * min },
  });
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({ timeouts: { checks: 45 * min, implement: 30 * min } });
  const id = String(created.body.id);
  const patch = (body: unknown) => call("PATCH", `/v1/projects/${id}`, body);
  const ok = await patch({
    timeouts: { implement: 60 * min },
    idleTimeoutMs: 15 * min,
    implementGuidance: "  Run `pnpm vitest run <file>` for targeted tests.  ",
  });
  expect(ok.status).toBe(200);
  // The posted timeouts replace the previous overrides as a whole.
  expect(ok.body).toMatchObject({
    timeouts: { implement: 60 * min, checks: 30 * min, review: 30 * min },
    idleTimeoutMs: 15 * min,
    implementGuidance: "Run `pnpm vitest run <file>` for targeted tests.",
  });
  const stored = (await factory.store.getProject(id)) as StoredProject;
  expect(stored).toMatchObject({ timeouts: { implement: 60 * min }, idleTimeoutMs: 15 * min });
  for (const bad of [
    { timeouts: { implement: 4 * min } },
    { timeouts: { implement: 121 * min } },
    { timeouts: { merge: 10 * min } },
    { timeouts: { implement: 10 * min + 0.5 } },
    { idleTimeoutMs: 0 },
    { implementGuidance: "x".repeat(4001) },
    { implementGuidance: "   " },
    { runTimeoutMs: 60 * min },
  ])
    expect((await patch(bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
  const cleared = await patch({ timeouts: null, idleTimeoutMs: null, implementGuidance: null });
  expect(cleared.status).toBe(200);
  expect(cleared.body).toMatchObject({ timeouts: { implement: 30 * min } });
  expect(cleared.body.idleTimeoutMs).toBeUndefined();
  expect(cleared.body.implementGuidance).toBeUndefined();
  const after = (await factory.store.getProject(id)) as StoredProject;
  expect(after.timeouts).toBeUndefined();
  expect(after.idleTimeoutMs).toBeUndefined();
  expect(after.implementGuidance).toBeUndefined();
  expect(
    (
      await call("POST", "/v1/projects", {
        name: "Bad",
        repo: { path: repo, baseBranch: "main" },
        tickets: { kind: "linear", linear },
        timeouts: { implement: 1000 },
      })
    ).status,
  ).toBe(400);
  await factory.stop();
});

test("checks take a parser and baseline mode via PATCH; unknown values are rejected", async () => {
  const { repo, factory, call } = await boot();
  const created = await call("POST", "/v1/projects", {
    name: "Baseline",
    repo: { path: repo, baseBranch: "main" },
    tickets: { kind: "linear", linear },
  });
  expect(created.status).toBe(200);
  const id = String(created.body.id);
  const patch = (body: unknown) => call("PATCH", `/v1/projects/${id}`, body);
  const checks = [
    {
      kind: "lint",
      cmd: ["npm", "--prefix", "app", "run", "lint"],
      parser: "eslint-json",
      baseline: "compare",
    },
    { kind: "test", cmd: ["npm", "test"], baseline: "strict" },
  ];
  const ok = await patch({ checks });
  expect(ok.status).toBe(200);
  expect(ok.body.checks).toEqual(checks);
  expect(((await factory.store.getProject(id)) as StoredProject).checks).toEqual(checks);
  for (const bad of [
    { checks: [{ kind: "lint", cmd: ["x"], parser: "eval" }] },
    { checks: [{ kind: "lint", cmd: ["x"], baseline: "loose" }] },
    { checks: [{ kind: "lint", cmd: ["x"], extra: 1 }] },
  ])
    expect((await patch(bad)).status, JSON.stringify(bad)).toBe(400);
  await factory.stop();
});

test("deploy profile: PATCHed through the REST route, validated, removed with null", async () => {
  const { repo, factory, call } = await boot();
  const created = await call("POST", "/v1/projects", {
    name: "Deploys",
    repo: { path: repo, baseBranch: "main" },
    tickets: { kind: "linear", linear },
  });
  const id = String(created.body.id);
  const patch = (body: unknown) => call("PATCH", `/v1/projects/${id}`, body);
  const target = {
    name: "web",
    kind: "git-integration",
    paths: ["**"],
    version: { url: "https://example.com/version.json", field: "commit" },
    health: { url: "https://example.com/", expect: 200 },
  };
  const ok = await patch({ deploy: { merge: "auto", targets: [target] } });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  expect(ok.body).toMatchObject({ autonomy: { merge: "autonomous" }, deploy: { merge: "auto" } });
  const bad = await patch({
    deploy: {
      merge: "auto",
      targets: [{ ...target, health: { url: "https://10.0.0.1/", expect: 200 } }],
    },
  });
  expect(bad.status).toBe(400);
  const cleared = await patch({ deploy: null });
  expect(cleared.body.deploy).toBeUndefined();
  expect(((await factory.store.getProject(id)) as StoredProject).deploy).toBeUndefined();
  await factory.stop();
});
