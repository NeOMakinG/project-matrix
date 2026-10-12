import { describe, expect, test } from "vitest";
import { setup } from "./test-helpers.js";

describe("budgets", () => {
  test("runsPerDay stops further runs and resets the next UTC day", async () => {
    let now = Date.parse("2026-10-12T10:00:00Z");
    const ctx = await setup(() => now);
    const token = ctx.key(["runs:start"], [ctx.project.id], { runsPerDay: 2 });
    const ticket = await ctx.core.createTicket(ctx.project.id, { title: "t", body: "" });
    const start = () =>
      ctx.call(token, "POST", "/v1/runs", {
        projectId: ctx.project.id,
        ticketId: ticket.id,
        phase: "spike",
      });

    expect((await start()).status).toBe(200);
    expect((await start()).status).toBe(200);
    const blocked = await start();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: { code: "budget_exceeded" } });

    now = Date.parse("2026-10-13T00:01:00Z");
    expect((await start()).status).toBe(200);
  });

  test("mutationsPerDay counts every mutating call but not reads", async () => {
    const ctx = await setup();
    const token = ctx.key(["read", "tickets:write"], [ctx.project.id], { mutationsPerDay: 1 });
    const path = `/v1/projects/${ctx.project.id}/tickets`;
    expect((await ctx.call(token, "POST", path, { title: "a", body: "" })).status).toBe(200);
    expect((await ctx.call(token, "GET", path)).status).toBe(200);
    expect((await ctx.call(token, "GET", path)).status).toBe(200);
    expect((await ctx.call(token, "POST", path, { title: "b", body: "" })).status).toBe(429);
  });
});

describe("rate limits", () => {
  test("token bucket per key with retry-after, refilled over time", async () => {
    let now = 1_000_000;
    const ctx = await setup(() => now);
    const token = ctx.key(["read"], [ctx.project.id], undefined, 3);
    for (let i = 0; i < 3; i++)
      expect((await ctx.call(token, "GET", "/v1/projects")).status).toBe(200);
    const limited = await ctx.call(token, "GET", "/v1/projects");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another key is unaffected.
    expect((await ctx.call(ctx.key(["read"]), "GET", "/v1/projects")).status).toBe(200);
    now += 20_000;
    expect((await ctx.call(token, "GET", "/v1/projects")).status).toBe(200);
  });
});

describe("audit log", () => {
  test("records allowed and denied mutations, not reads", async () => {
    const ctx = await setup();
    const reader = ctx.key(["read"]);
    const writer = ctx.key(["tickets:write"]);
    const path = `/v1/projects/${ctx.project.id}/tickets`;
    await ctx.call(writer, "POST", path, { title: "ok", body: "" });
    await ctx.call(reader, "POST", path, { title: "denied", body: "" });
    await ctx.call(reader, "GET", path);

    const entries = await ctx.json<
      { action: string; status: number; detail?: string; projectId?: string }[]
    >(await ctx.call(ctx.admin, "GET", `/v1/audit?projectId=${ctx.project.id}`));
    expect(entries.map((e) => [e.action, e.status])).toEqual([
      ["tickets:write", 200],
      ["tickets:write", 403],
    ]);
    expect(entries[1]?.detail).toBe("scope");
  });

  test("invalid bodies are rejected with 400 before reaching the core", async () => {
    const ctx = await setup();
    const token = ctx.key(["tickets:write"]);
    const response = await ctx.call(token, "POST", `/v1/projects/${ctx.project.id}/tickets`, {
      body: "no title",
    });
    expect(response.status).toBe(400);
    expect(ctx.core.tickets.get(ctx.project.id)).toHaveLength(0);
  });
});
