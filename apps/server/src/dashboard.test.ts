import { describe, expect, test } from "vitest";
import { createServer } from "./http/app.js";
import { MemoryCore } from "./memory-core.js";
import { AGENT, setup } from "./test-helpers.js";

async function sessionServer() {
  const core = new MemoryCore();
  const server = createServer({
    core,
    sessions: { allowedOrigins: ["https://dashboard.example"], secureCookies: true },
  });
  const human = server.keys.create({
    name: "valentin",
    kind: "human",
    scope: { projects: "*", actions: ["admin"] },
  }).token;
  const agent = server.keys.create({
    name: "bot",
    scope: { projects: "*", actions: ["admin"] },
  }).token;

  const login = async (token: string) => {
    const response = await server.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    const body = (await response.json()) as { csrfToken?: string };
    return {
      response,
      cookie: cookie.split(";")[0] ?? "",
      setCookie: cookie,
      csrf: body.csrfToken ?? "",
    };
  };

  const request = (
    path: string,
    init: { method?: string; cookie?: string; csrf?: string; origin?: string; body?: unknown } = {},
  ) =>
    server.app.request(path, {
      method: init.method ?? "GET",
      headers: {
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.csrf ? { "x-csrf-token": init.csrf } : {}),
        ...(init.origin ? { origin: init.origin } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  return { core, server, human, agent, login, request };
}

describe("dashboard session auth", () => {
  test("login sets a hardened cookie that never contains the API key", async () => {
    const s = await sessionServer();
    const { response, setCookie, csrf } = await s.login(s.human);
    expect(response.status).toBe(200);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).not.toContain(s.human.split("_")[2]);
    expect(csrf.length).toBeGreaterThan(20);
  });

  test("agent keys and wrong tokens can't open a session", async () => {
    const s = await sessionServer();
    expect((await s.login(s.agent)).response.status).toBe(403);
    expect(
      (await s.login("mx_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).response
        .status,
    ).toBe(401);
  });

  test("cookie reads work; cookie writes need the CSRF token and an allowed origin", async () => {
    const s = await sessionServer();
    const { cookie, csrf } = await s.login(s.human);
    expect((await s.request("/v1/projects", { cookie })).status).toBe(200);

    const create = (extra: { csrf?: string; origin?: string }) =>
      s.request("/v1/projects", { method: "POST", cookie, body: { name: "via-cookie" }, ...extra });
    expect((await create({})).status).toBe(403);
    expect((await create({ csrf: "wrong" })).status).toBe(403);
    expect((await create({ csrf, origin: "https://evil.example" })).status).toBe(403);
    expect((await create({ csrf, origin: "https://dashboard.example" })).status).toBe(200);
    expect(s.core.projects.size).toBe(1);
  });

  test("SSE works with the session cookie", async () => {
    const s = await sessionServer();
    const project = await s.core.createProject({ name: "p", description: "", workspace: "native" });
    const ticket = await s.core.createTicket(project.id, { title: "t", body: "" });
    const run = await s.core.startRun(
      { projectId: project.id, ticketId: ticket.id, phase: "qa" },
      AGENT,
    );
    const { cookie } = await s.login(s.human);
    const response = await s.request(`/v1/runs/${run.id}/events`, { cookie });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain("event: ready");
    await reader?.cancel();
  });

  test("logout and key revocation end the session", async () => {
    const s = await sessionServer();
    const a = await s.login(s.human);
    expect((await s.request("/auth/logout", { method: "POST", cookie: a.cookie })).status).toBe(
      403,
    );
    expect(
      (await s.request("/auth/logout", { method: "POST", cookie: a.cookie, csrf: a.csrf })).status,
    ).toBe(200);
    expect((await s.request("/v1/projects", { cookie: a.cookie })).status).toBe(401);

    const b = await s.login(s.human);
    expect((await s.request("/auth/session", { cookie: b.cookie })).status).toBe(200);
    s.server.keys.revoke(s.human.split("_")[1] ?? "");
    expect((await s.request("/v1/projects", { cookie: b.cookie })).status).toBe(401);
    expect((await s.request("/auth/session", { cookie: b.cookie })).status).toBe(401);
  });

  test("MCP never accepts the session cookie", async () => {
    const s = await sessionServer();
    const { cookie } = await s.login(s.human);
    const response = await s.request("/mcp", {
      method: "POST",
      cookie,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(response.status).toBe(401);
  });
});

describe("dashboard read models", () => {
  test("overview, incidents, model health and Orca runtime are scoped to the key", async () => {
    const ctx = await setup();
    const ticket = await ctx.core.createTicket(ctx.project.id, { title: "t", body: "" });
    const run = await ctx.core.startRun(
      { projectId: ctx.project.id, ticketId: ticket.id, phase: "qa" },
      AGENT,
    );
    ctx.core.runs.set(run.id, { ...run, state: "running", costUsd: 1.25 });
    await ctx.core.ingestSignal({
      source: "sentry",
      kind: "created",
      title: "boom",
      fingerprint: "f1",
      projectId: ctx.project.id,
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    await ctx.core.ingestSignal({
      source: "sentry",
      kind: "created",
      title: "boom",
      fingerprint: "f1",
      projectId: ctx.project.id,
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    await ctx.core.ingestSignal({
      source: "sentry",
      kind: "created",
      title: "elsewhere",
      fingerprint: "f2",
      projectId: ctx.other.id,
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    await ctx.core.ingestSignal({
      source: "otel",
      kind: "firing",
      title: "unattributed",
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    ctx.core.modelHealth.push({
      model: "claude-fable-5-1",
      provider: "claude",
      status: "ok",
      utilization: 0.23,
    });
    await ctx.core.recordOrcaStatus({
      worktree: "wt/1",
      agent: "claude-code",
      status: "working",
      receivedAt: new Date().toISOString(),
    });

    const reader = ctx.key(["read"]);
    const overview = await ctx.json<{
      activeRuns: number;
      costTodayUsd: number;
      openIncidents: number;
      projects: { id: string }[];
    }>(await ctx.call(reader, "GET", "/v1/overview"));
    expect(overview).toMatchObject({ activeRuns: 1, costTodayUsd: 1.25, openIncidents: 1 });
    expect(overview.projects.map((p) => p.id)).toEqual([ctx.project.id]);

    const incidents = await ctx.json<{ title: string; count: number }[]>(
      await ctx.call(reader, "GET", "/v1/incidents"),
    );
    expect(incidents).toEqual([expect.objectContaining({ title: "boom", count: 2 })]);
    const adminIncidents = await ctx.json<unknown[]>(
      await ctx.call(ctx.admin, "GET", "/v1/incidents"),
    );
    expect(adminIncidents).toHaveLength(3);

    const health = await ctx.json<{ model: string }[]>(
      await ctx.call(reader, "GET", "/v1/gateway/health"),
    );
    expect(health[0]?.model).toBe("claude-fable-5-1");
    const orca = await ctx.json<{ status: string; activeWorktrees: number }>(
      await ctx.call(reader, "GET", "/v1/orca/runtime"),
    );
    expect(orca).toMatchObject({ status: "healthy", activeWorktrees: 1 });
  });

  test("key update can't loosen limits beyond the caller's", async () => {
    const ctx = await setup();
    const target = ctx.server.keys.create({
      name: "t",
      scope: { projects: [ctx.project.id], actions: ["read"] },
    });
    const limitedAdmin = ctx.server.keys.create({
      name: "limited",
      scope: { projects: "*", actions: ["admin"] },
      ratePerMinute: 50,
    }).token;
    const patch = (token: string, body: unknown) =>
      ctx.call(token, "PATCH", `/v1/keys/${target.key.id}`, body);
    expect((await patch(limitedAdmin, { ratePerMinute: 500 })).status).toBe(403);
    expect((await patch(limitedAdmin, { ratePerMinute: 40, name: "renamed" })).status).toBe(200);
    expect(ctx.server.keys.get(target.key.id)?.name).toBe("renamed");
    expect((await patch(ctx.key(["admin"]), { name: "x" })).status).toBe(403);
  });
});
