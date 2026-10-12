import { readFileSync } from "node:fs";
import { createServer, MemoryCore } from "@matrix/server";
import { describe, expect, test } from "vitest";
import { createMatrixClient, name } from "./index.js";

describe("@matrix/sdk", () => {
  test("package name", () => {
    expect(name).toBe("@matrix/sdk");
  });

  test("committed OpenAPI document matches the server", async () => {
    const { app } = createServer({ core: new MemoryCore() });
    const live = await (await app.request("/openapi.json")).json();
    const committed = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
    expect(committed, "run `bun run generate` in packages/sdk").toEqual(live);
  });

  test("typed client talks to the server", async () => {
    const core = new MemoryCore();
    const server = createServer({ core });
    const { token } = server.keys.create({
      name: "sdk",
      scope: { projects: "*", actions: ["admin"] },
    });
    const client = createMatrixClient({
      baseUrl: "http://matrix.test",
      apiKey: token,
      fetch: async (input, init) =>
        server.app.request(input instanceof Request ? input : String(input), init),
    });

    const created = await client.api.POST("/v1/projects", {
      body: { name: "sdk-project", description: "", workspace: "native" },
    });
    expect(created.data?.name).toBe("sdk-project");
    const projectId = created.data?.id ?? "";

    const ticket = await client.api.POST("/v1/projects/{projectId}/tickets", {
      params: { path: { projectId } },
      body: { title: "Typed ticket", body: "" },
    });
    expect(ticket.data?.status).toBe("open");

    const forbidden = await createMatrixClient({
      baseUrl: "http://matrix.test",
      apiKey: server.keys.create({ name: "r", scope: { projects: "*", actions: ["read"] } }).token,
      fetch: async (input, init) =>
        server.app.request(input instanceof Request ? input : String(input), init),
    }).api.POST("/v1/projects/{projectId}/deploy", { params: { path: { projectId } } });
    expect(forbidden.response.status).toBe(403);
    expect(forbidden.error?.error.code).toBe("forbidden");

    expect(client.mcp.url).toBe("http://matrix.test/mcp");
  });
});
