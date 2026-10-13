import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState, type PhaseContext } from "@matrix/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { FakeTicketStore, testProject } from "../../core/src/testing/fakes.js";
import type { OperatorConfig } from "./config.js";
import { createFigmaDesignAdapter, restrictedMcpFetch } from "./factory.js";
import { encodePng } from "./images.js";
import { ArtifactStore } from "./storage.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
test("official StreamableHTTP client/server exchange with explicit 0600 credential, no sockets", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "matrix-design-http-")));
  await chmod(root, 0o700);
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "figma-test"), "explicit-fixture-token", { mode: 0o600 });
  const server = new McpServer({ name: "figma-streamable-fixture", version: "1" });
  const annotations = { readOnlyHint: true };
  server.registerTool("whoami", { inputSchema: {}, annotations }, async () => ({
    content: [{ type: "text", text: JSON.stringify({ email: "fixture@example.test" }) }],
  }));
  const inputSchema = { fileKey: z.string(), nodeId: z.string() };
  server.registerTool("get_design_context", { inputSchema, annotations }, async () => ({
    content: [{ type: "text", text: "Frame" }],
  }));
  server.registerTool("get_screenshot", { inputSchema, annotations }, async () => ({
    content: [
      {
        type: "image",
        mimeType: "image/png",
        data: encodePng(1, 1, Buffer.from([1, 2, 3, 255])).toString("base64"),
      },
    ],
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => "fixture-session",
  });
  await server.connect(transport as Transport);
  cleanup.push(() => server.close());
  const seen: string[] = [];
  const transportFetch: typeof fetch = vi.fn(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://mcp.figma.com/mcp");
    expect(request.headers.get("authorization")).toBe("Bearer explicit-fixture-token");
    expect(request.redirect).toBe("error");
    seen.push(request.method);
    return transport.handleRequest(request);
  });
  const config: OperatorConfig = {
    serverName: "figma",
    endpoint: "https://mcp.figma.com/mcp",
    credentialRef: "figma-test",
    authMode: "credential-store",
    fileKey: "Matrix123",
    nodes: ["1:2"],
    authenticationTool: { name: "whoami", identityPath: ["email"] },
    contextTool: { name: "get_design_context", fileArgument: "fileKey", nodeArgument: "nodeId" },
    screenshotTool: { name: "get_screenshot", fileArgument: "fileKey", nodeArgument: "nodeId" },
    downloadOrigins: [],
  };
  const runtime = await createFigmaDesignAdapter({
    config,
    transportFetch,
    authorization: {
      kind: "credential-store",
      operatorAuthorized: true,
      origin: "https://mcp.figma.com",
      credentialRef: "figma-test",
      root,
    },
    dependencies: {
      artifacts: new ArtifactStore(root),
      qaRoot: root,
      comparisonScope: { resolve: async () => [] },
    },
  });
  expect(runtime.runnerMcp.hostCaptureOnly).toBe(true);
  const tickets = new FakeTicketStore();
  const ticket = tickets.add("UI");
  const project = testProject({
    design: {
      productGoals: ["Clarity"],
      artDirection: "Calm",
      componentLibrary: "Existing",
      adrs: [],
      figmaFileUrl: "https://www.figma.com/design/Matrix123/Matrix",
    },
  });
  const ctx: PhaseContext = {
    project,
    ticket,
    tickets,
    workflow: initialState(project.id, ticket.id),
    runId: "http-capture",
    headSha: "a".repeat(40),
    workdir: join(root, "worktree"),
    branch: "feature",
    idempotencyKey: "http-capture",
    signal: new AbortController().signal,
    emit: () => {},
    scratchDir: async () => root,
    stillOwner: async () => true,
    authorize: async () => ({ ok: false, kind: "gates", reason: "capture only" }),
  };
  const captured = await runtime.figma.capture(
    ctx,
    "https://www.figma.com/design/Matrix123/Matrix?node-id=1-2",
  );
  expect(captured.screenshot.bytes.length).toBeGreaterThan(50);
  expect(runtime.runnerMcp).not.toHaveProperty("authorization");
  expect(seen.filter((method) => method === "POST").length).toBeGreaterThanOrEqual(4);
  await runtime.close();
  const rejected = vi.fn<typeof fetch>();
  await expect(
    createFigmaDesignAdapter({
      config,
      transportFetch: rejected,
      authorization: {
        kind: "credential-store",
        operatorAuthorized: true,
        origin: "https://evil.example",
        credentialRef: "figma-test",
        root,
      },
      dependencies: {
        artifacts: new ArtifactStore(root),
        qaRoot: root,
        comparisonScope: { resolve: async () => [] },
      },
    }),
  ).rejects.toThrow(/authorization required/);
  expect(rejected).not.toHaveBeenCalled();
});
test("HTTPS/origin restrictions prevent credential forwarding including Request headers", async () => {
  const underlying = vi.fn<typeof fetch>(
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  const guard = restrictedMcpFetch(
    "https://mcp.figma.com/mcp",
    ["https://mcp.figma.com", "https://oauth.example"],
    underlying,
  );
  for (const request of [
    new Request("https://evil.example/mcp"),
    new Request("http://mcp.figma.com/mcp"),
    new Request("https://oauth.example/token", {
      headers: { Authorization: "Bearer fixture-secret" },
    }),
    new Request("https://mcp.figma.com/other", {
      headers: { Authorization: "Bearer fixture-secret" },
    }),
    new Request("https://mcp.figma.com/mcp", { headers: { Cookie: "fixture-secret" } }),
  ])
    await expect(guard(request)).rejects.toThrow(/forwarding denied/);
  expect(underlying).not.toHaveBeenCalled();
  const response = await guard("https://mcp.figma.com/mcp", {
    headers: { Authorization: "Bearer fixture-secret" },
  });
  expect(await response.text()).toBe("{}");
  expect(underlying.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", credentials: "omit" });
  underlying.mockImplementationOnce(
    async () => new Response("{}", { headers: { "content-length": "999999999" } }),
  );
  await expect(guard("https://mcp.figma.com/mcp")).rejects.toThrow(/size denied/);
});
