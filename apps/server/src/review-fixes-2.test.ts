import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "vitest";
import { createServer } from "./http/app.js";
import { MemoryCore } from "./memory-core.js";
import { AGENT, nowTs, setup } from "./test-helpers.js";
import { hmacHex } from "./webhooks.js";

describe("webhook replay protection", () => {
  test("a delivery id is accepted once", async () => {
    const ctx = await setup();
    const body = JSON.stringify({ action: "created", data: { issue: { id: "9", title: "boom" } } });
    const headers = {
      "content-type": "application/json",
      "sentry-hook-signature": hmacHex("sentry-test-secret", body),
      "sentry-hook-timestamp": nowTs(),
      "request-id": "delivery-1",
    };
    const send = () => ctx.server.app.request("/hooks/sentry", { method: "POST", body, headers });
    expect((await send()).status).toBe(202);
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ duplicate: true });
    expect(ctx.core.signals).toHaveLength(1);
  });

  test("a new request-id doesn't make a replayed signed body acceptable (round 2)", async () => {
    const ctx = await setup();
    const body = JSON.stringify({
      action: "created",
      data: { issue: { id: "7", title: "replay" } },
    });
    const send = (requestId: string) =>
      ctx.server.app.request("/hooks/sentry", {
        method: "POST",
        body,
        headers: {
          "sentry-hook-signature": hmacHex("sentry-test-secret", body),
          "sentry-hook-timestamp": nowTs(),
          "request-id": requestId,
        },
      });
    expect((await send("first")).status).toBe(202);
    const replay = await send("brand-new-id");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ duplicate: true });
    expect(ctx.core.signals).toHaveLength(1);
  });

  test("Sentry deliveries outside the timestamp window are refused", async () => {
    let now = Date.parse("2026-10-12T12:00:00Z");
    const ctx = await setup(() => now);
    const body = JSON.stringify({ data: { issue: { id: "8", title: "old" } } });
    const send = (timestamp: number) =>
      ctx.server.app.request("/hooks/sentry", {
        method: "POST",
        body,
        headers: {
          "sentry-hook-signature": hmacHex("sentry-test-secret", body),
          "sentry-hook-timestamp": String(Math.floor(timestamp / 1000)),
        },
      });
    expect((await send(now - 10 * 60 * 1000)).status).toBe(401);
    expect((await send(now)).status).toBe(202);
    now += 1000;
  });

  test("bearer-secret hooks dedupe identical bodies without a delivery id", async () => {
    const ctx = await setup();
    const body = JSON.stringify({ status: "firing", alerts: [{ labels: { alertname: "X" } }] });
    const send = () =>
      ctx.server.app.request("/hooks/otel", {
        method: "POST",
        body,
        headers: { authorization: "Bearer otel-test-secret" },
      });
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(200);
    expect(ctx.core.signals).toHaveLength(1);
  });

  test("project attribution needs that project's own secret", async () => {
    const core = new MemoryCore();
    const project = await core.createProject({ name: "a", description: "", workspace: "native" });
    const other = await core.createProject({ name: "b", description: "", workspace: "native" });
    const { app } = createServer({
      core,
      secrets: {
        sentry: "global-secret",
        projects: { [project.id]: { sentry: "project-a-secret" } },
      },
    });
    const body = JSON.stringify({ data: { issue: { id: "1", title: "t" } } });
    const send = (projectId: string, secret: string, id: string) =>
      app.request(`/hooks/sentry?project=${projectId}`, {
        method: "POST",
        body,
        headers: {
          "sentry-hook-signature": hmacHex(secret, body),
          "sentry-hook-timestamp": nowTs(),
          "request-id": id,
        },
      });
    // Replaying a globally signed payload into a project is refused.
    expect((await send(project.id, "global-secret", "d1")).status).toBe(401);
    // Project A's signature can't be pointed at project B.
    expect((await send(other.id, "project-a-secret", "d2")).status).toBe(401);
    expect((await send(project.id, "project-a-secret", "d3")).status).toBe(202);
    expect(core.signals.map((s) => s.projectId)).toEqual([project.id]);
  });
});

describe("audit and idempotency", () => {
  test("if the audit intent can't be written, the operation never runs", async () => {
    const core = new MemoryCore();
    const server = createServer({ core, auditFile: "/nonexistent-dir/audit.jsonl" });
    const { token } = server.keys.create({
      name: "a",
      scope: { projects: "*", actions: ["admin"] },
    });
    const response = await server.app.request("/v1/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "should-not-exist" }),
    });
    expect(response.status).toBe(500);
    expect(core.projects.size).toBe(0);
  });

  test("an Idempotency-Key replays the first result instead of running twice", async () => {
    const ctx = await setup();
    const token = ctx.key(["tickets:write"]);
    const send = (path: string, key: string) =>
      ctx.server.app.request(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ title: "once", body: "" }),
      });
    const path = `/v1/projects/${ctx.project.id}/tickets`;
    const first = await ctx.json<{ id: string }>(await send(path, "create-ticket-0001"));
    const second = await ctx.json<{ id: string }>(await send(path, "create-ticket-0001"));
    expect(second.id).toBe(first.id);
    expect(ctx.core.tickets.get(ctx.project.id)).toHaveLength(1);
    expect((await send(`/v1/projects/${ctx.other.id}/tickets`, "create-ticket-0001")).status).toBe(
      403,
    );
    expect((await send(path, "bad key")).status).toBe(400);
  });
});

describe("MCP hardening", () => {
  async function connect(ctx: Awaited<ReturnType<typeof setup>>, token: string) {
    const transport = new StreamableHTTPClientTransport(new URL("http://matrix.test/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => ctx.server.app.request(String(input), init as RequestInit),
    });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    return client;
  }

  test("MCP enforces the same input limits as REST", async () => {
    const ctx = await setup();
    const client = await connect(ctx, ctx.key(["tickets:write"]));
    const tooLong = await client.callTool({
      name: "create_ticket",
      arguments: { projectId: ctx.project.id, title: "x".repeat(301), body: "" },
    });
    expect(tooLong.isError).toBe(true);
    expect(ctx.core.tickets.get(ctx.project.id)).toHaveLength(0);
    await client.close();
  });

  test("unexpected errors are not leaked to MCP clients", async () => {
    const ctx = await setup();
    ctx.core.listTickets = async () => {
      throw new Error("db password=hunter2 at /srv/internal");
    };
    const client = await connect(ctx, ctx.key(["read"]));
    const result = await client.callTool({
      name: "list_tickets",
      arguments: { projectId: ctx.project.id },
    });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(result.isError).toBe(true);
    expect(text).toBe("500 internal: internal error");
    await client.close();
  });
});

describe("SSE hardening", () => {
  async function openStream(ctx: Awaited<ReturnType<typeof setup>>, token: string) {
    const ticket = await ctx.core.createTicket(ctx.project.id, { title: "t", body: "" });
    const run = await ctx.core.startRun(
      { projectId: ctx.project.id, ticketId: ticket.id, phase: "qa" },
      AGENT,
    );
    const response = await ctx.call(token, "GET", `/v1/runs/${run.id}/events`);
    return { runId: run.id, reader: response.body?.getReader() };
  }

  async function readUntilEnd(reader: ReadableStreamDefaultReader<Uint8Array> | undefined) {
    if (!reader) throw new Error("no body");
    let text = "";
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
    }
  }

  test("revoking the key closes its open streams", async () => {
    const ctx = await setup();
    const token = ctx.key(["read"]);
    const { reader } = await openStream(ctx, token);
    const ended = readUntilEnd(reader);
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.server.keys.revoke(token.split("_")[1] ?? "");
    const text = await ended;
    expect(text).toContain("event: close");
    expect(text).toContain('"reason":"revoked"');
  });

  test("a client that doesn't read is disconnected instead of growing an unbounded queue", async () => {
    const ctx = await setup();
    const { runId, reader } = await openStream(ctx, ctx.key(["read"]));
    for (let i = 0; i < 1500; i++) {
      ctx.core.emit({ runId, at: new Date().toISOString(), kind: "log", message: `line ${i}` });
    }
    const text = await readUntilEnd(reader);
    expect(text).toContain('"reason":"overflow"');
  });
});
