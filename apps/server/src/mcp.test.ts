import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "vitest";
import { setup } from "./test-helpers.js";

async function connect(ctx: Awaited<ReturnType<typeof setup>>, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL("http://matrix.test/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (input, init) => ctx.server.app.request(String(input), init as RequestInit),
  });
  const client = new Client({ name: "matrix-test", version: "0.0.0" });
  // The SDK's transport typing predates exactOptionalPropertyTypes.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return client;
}

const text = (result: unknown) =>
  ((result as { content: { type: string; text: string }[] }).content[0]?.text ?? "") as string;

describe("MCP server", () => {
  test("lists the same capabilities as the REST API", async () => {
    const ctx = await setup();
    const client = await connect(ctx, ctx.admin);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        "list_projects",
        "list_tickets",
        "create_ticket",
        "start_run",
        "approve_run",
        "merge_run",
        "deploy_project",
        "set_autonomy",
        "get_product_graph",
        "answer_init",
      ]),
    );
    await client.close();
  });

  test("tool calls go through the same scopes as REST", async () => {
    const ctx = await setup();
    const writer = await connect(ctx, ctx.key(["read", "tickets:write"]));
    const created = await writer.callTool({
      name: "create_ticket",
      arguments: { projectId: ctx.project.id, title: "From MCP", body: "agent-created" },
    });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(created))).toMatchObject({ title: "From MCP", status: "open" });

    const listed = await writer.callTool({
      name: "list_tickets",
      arguments: { projectId: ctx.project.id },
    });
    expect(JSON.parse(text(listed))).toHaveLength(1);

    const denied = await writer.callTool({
      name: "deploy_project",
      arguments: { projectId: ctx.project.id },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("403 forbidden");

    const otherProject = await writer.callTool({
      name: "create_ticket",
      arguments: { projectId: ctx.other.id, title: "nope", body: "" },
    });
    expect(otherProject.isError).toBe(true);
    await writer.close();
  });

  test("MCP mutations are audited under the calling key", async () => {
    const ctx = await setup();
    const token = ctx.key(["tickets:write"]);
    const client = await connect(ctx, token);
    await client.callTool({
      name: "create_ticket",
      arguments: { projectId: ctx.project.id, title: "x", body: "" },
    });
    await client.close();
    const keyId = token.split("_")[1] ?? "";
    expect(ctx.server.audit.list({ keyId }).map((e) => e.status)).toEqual([0, 200]);
  });

  test("resources expose ADRs and the product graph", async () => {
    const ctx = await setup();
    ctx.core.adrs.set(ctx.project.id, [
      { id: "0001", title: "TypeScript", status: "accepted", path: "docs/adr/0001.md", rules: [] },
    ]);
    const client = await connect(ctx, ctx.key(["read"]));
    const resource = await client.readResource({ uri: `matrix://projects/${ctx.project.id}/adrs` });
    const first = resource.contents[0] as { text: string };
    expect(JSON.parse(first.text)).toHaveLength(1);
    await client.close();
  });

  test("rejects requests without a valid key", async () => {
    const ctx = await setup();
    const response = await ctx.server.app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});
