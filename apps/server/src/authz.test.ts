import { describe, expect, test } from "vitest";
import type { Action } from "./auth/keys.js";
import { setup } from "./test-helpers.js";

type Case = {
  name: string;
  action: Action;
  run: (ctx: Awaited<ReturnType<typeof setup>>, token: string) => Promise<Response>;
};

const runIdFor = async (ctx: Awaited<ReturnType<typeof setup>>, state?: string) => {
  const ticket = await ctx.core.createTicket(ctx.project.id, { title: "t", body: "" });
  const run = await ctx.core.startRun({
    projectId: ctx.project.id,
    ticketId: ticket.id,
    phase: "implement",
  });
  if (state) ctx.core.runs.set(run.id, { ...run, state: state as never });
  return run.id;
};

const cases: Case[] = [
  {
    name: "list tickets",
    action: "read",
    run: (c, t) => c.call(t, "GET", `/v1/projects/${c.project.id}/tickets`),
  },
  {
    name: "list adrs",
    action: "read",
    run: (c, t) => c.call(t, "GET", `/v1/projects/${c.project.id}/adrs`),
  },
  {
    name: "create ticket",
    action: "tickets:write",
    run: (c, t) =>
      c.call(t, "POST", `/v1/projects/${c.project.id}/tickets`, { title: "x", body: "" }),
  },
  {
    name: "start run",
    action: "runs:start",
    run: async (c, t) => {
      const ticket = await c.core.createTicket(c.project.id, { title: "t", body: "" });
      return c.call(t, "POST", "/v1/runs", {
        projectId: c.project.id,
        ticketId: ticket.id,
        phase: "spike",
      });
    },
  },
  {
    name: "approve run",
    action: "runs:approve",
    run: async (c, t) =>
      c.call(t, "POST", `/v1/runs/${await runIdFor(c, "awaiting_approval")}/approval`, {
        decision: "approve",
      }),
  },
  {
    name: "merge run",
    action: "merge",
    run: async (c, t) => {
      await c.core.setAutonomy(c.project.id, "merge", "gated");
      return c.call(t, "POST", `/v1/runs/${await runIdFor(c, "running")}/merge`);
    },
  },
  {
    name: "deploy",
    action: "deploy",
    run: (c, t) => c.call(t, "POST", `/v1/projects/${c.project.id}/deploy`),
  },
  {
    name: "set autonomy",
    action: "admin",
    run: (c, t) =>
      c.call(t, "PUT", `/v1/projects/${c.project.id}/autonomy`, { phase: "merge", mode: "gated" }),
  },
];

const ALL: Action[] = [
  "read",
  "tickets:write",
  "runs:start",
  "runs:approve",
  "merge",
  "deploy",
  "admin",
];

describe("scope matrix", () => {
  for (const item of cases) {
    for (const granted of ALL) {
      const expectOk = granted === item.action || granted === "admin";
      test(`${item.name} with ${granted} → ${expectOk ? "allowed" : "403"}`, async () => {
        const ctx = await setup();
        const response = await item.run(ctx, ctx.key([granted]));
        if (expectOk) expect(response.status, await response.clone().text()).toBe(200);
        else expect(response.status).toBe(403);
      });
    }
  }
});

describe("project scoping", () => {
  test("a key scoped to one project can't touch another", async () => {
    const ctx = await setup();
    const token = ctx.key(["read", "tickets:write"]);
    expect((await ctx.call(token, "GET", `/v1/projects/${ctx.other.id}/tickets`)).status).toBe(403);
    expect(
      (
        await ctx.call(token, "POST", `/v1/projects/${ctx.other.id}/tickets`, {
          title: "x",
          body: "",
        })
      ).status,
    ).toBe(403);
    const projects = await ctx.json<{ id: string }[]>(await ctx.call(token, "GET", "/v1/projects"));
    expect(projects.map((p) => p.id)).toEqual([ctx.project.id]);
  });

  test("run access follows the run's project", async () => {
    const ctx = await setup();
    const ticket = await ctx.core.createTicket(ctx.other.id, { title: "t", body: "" });
    const run = await ctx.core.startRun({
      projectId: ctx.other.id,
      ticketId: ticket.id,
      phase: "qa",
    });
    const token = ctx.key(["read", "runs:start"]);
    expect((await ctx.call(token, "GET", `/v1/runs/${run.id}`)).status).toBe(403);
    expect((await ctx.call(token, "POST", `/v1/runs/${run.id}/cancel`)).status).toBe(403);
  });
});

describe("authentication", () => {
  test("missing, malformed and revoked keys are rejected", async () => {
    const ctx = await setup();
    expect((await ctx.call(null, "GET", "/v1/projects")).status).toBe(401);
    expect((await ctx.call("mx_nope", "GET", "/v1/projects")).status).toBe(401);
    const token = ctx.key(["read"]);
    const id = token.split("_")[1] ?? "";
    expect((await ctx.call(ctx.admin, "DELETE", `/v1/keys/${id}`)).status).toBe(200);
    expect((await ctx.call(token, "GET", "/v1/projects")).status).toBe(401);
  });

  test("created tokens are returned once and never listed", async () => {
    const ctx = await setup();
    const created = await ctx.json<{ token: string; key: { id: string } }>(
      await ctx.call(ctx.admin, "POST", "/v1/keys", {
        name: "ci",
        scope: { projects: "*", actions: ["read"] },
      }),
    );
    expect(created.token).toMatch(/^mx_[a-z0-9]{12}_/);
    const listed = await (await ctx.call(ctx.admin, "GET", "/v1/keys")).text();
    expect(listed).not.toContain(created.token.split("_")[2]);
    expect(listed).not.toContain("hash");
  });

  test("health and OpenAPI document are public", async () => {
    const ctx = await setup();
    expect((await ctx.call(null, "GET", "/healthz")).status).toBe(200);
    const doc = await ctx.json<{ paths: Record<string, unknown> }>(
      await ctx.call(null, "GET", "/openapi.json"),
    );
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/v1/projects",
        "/v1/runs",
        "/v1/runs/{id}/merge",
        "/v1/keys",
        "/v1/audit",
      ]),
    );
  });
});
