import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, test } from "vitest";
import { orcaCommand } from "./command";
import { mcpConfigFor, type OrcaAgent, registerMcp } from "./mcp";

const serverUrl = "https://matrix.example";
const token = (id: string) => `mx_${id}_${"s".repeat(43)}`;

describe.each(["claude-code", "codex", "opencode"] as OrcaAgent[])("multi-project %s", (agent) => {
  test("adds projects together; rotates only the selected credential after writing", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-projects-"));
    const calls: string[] = [];
    let sequence = 0;
    const metadata: Array<{
      id: string;
      name: string;
      kind: string;
      scope: { projects: string[]; actions: string[] };
    }> = [];
    const fetchImpl = (async (input, init) => {
      if (init?.method === "GET") {
        expect(String(input)).toBe(`${serverUrl}/v1/keys`);
        return new Response(JSON.stringify(metadata));
      }
      if (init?.method === "DELETE") {
        const target = mcpConfigFor(agent, home, `${serverUrl}/mcp`, "", "travel");
        const content = await readFile(target.file, "utf8");
        expect(content).toContain(token("000000000003"));
        expect(content).not.toContain(token("000000000001"));
        calls.push(String(input));
        return new Response("{}");
      }
      const spec = JSON.parse(String(init?.body));
      expect(spec.scope.projects).toHaveLength(1);
      sequence += 1;
      const id = String(sequence).padStart(12, "0");
      expect(spec.name).toBe(`matrix-mcp:${agent}:${spec.scope.projects[0]}`);
      metadata.push({ ...spec, id });
      return new Response(JSON.stringify({ token: token(id), key: { id } }));
    }) as typeof fetch;
    const options = {
      serverUrl,
      home,
      agents: [agent],
      actions: ["read"],
      adminKey: "admin",
      apply: true,
      fetchImpl,
      log: () => {},
    };
    await registerMcp({ ...options, projects: ["travel", "work", "travel"] });
    expect(sequence).toBe(2);
    const target = mcpConfigFor(agent, home, `${serverUrl}/mcp`, "", "travel");
    const before = await readFile(target.file, "utf8");
    expect(before).toContain("matrix-travel");
    expect(before).toContain("matrix-work");
    await registerMcp({ ...options, projects: ["travel"] });
    const after = await readFile(target.file, "utf8");
    expect(after).toContain(token("000000000002"));
    expect(calls).toEqual([`${serverUrl}/v1/keys/000000000001`]);
    expect((await stat(target.file)).mode & 0o777).toBe(0o600);
    if (agent !== "codex") {
      const root = agent === "claude-code" ? "mcpServers" : "mcp";
      expect(parse(after)[root]["matrix-work"]).toEqual(parse(before)[root]["matrix-work"]);
    }
    const backup = (await readdir(join(target.file, ".."))).find((file) =>
      file.includes(".bak-matrix-"),
    );
    expect(backup).toBeDefined();
    expect((await stat(join(target.file, "..", backup as string))).mode & 0o777).toBe(0o600);
  });
});

test("revocation failure preserves installed credentials and reports failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-revoke-"));
  const target = mcpConfigFor(
    "claude-code",
    home,
    `${serverUrl}/mcp`,
    token("000000000001"),
    "travel",
  );
  await writeFile(target.file, target.merge(""));
  const deleted: string[] = [];
  const fetchImpl = (async (input, init) => {
    if (init?.method === "GET")
      return new Response(
        JSON.stringify([
          {
            id: "000000000001",
            name: "matrix-mcp:claude-code:travel",
            kind: "agent",
            scope: { projects: ["travel"], actions: ["read"] },
          },
        ]),
      );
    if (init?.method === "DELETE") {
      deleted.push(String(input));
      return new Response("{}", { status: 500 });
    }
    return new Response(
      JSON.stringify({ token: token("000000000002"), key: { id: "000000000002" } }),
    );
  }) as typeof fetch;
  await expect(
    registerMcp({
      serverUrl,
      home,
      agents: ["claude-code"],
      projects: ["travel"],
      actions: ["read"],
      adminKey: "admin",
      apply: true,
      fetchImpl,
      log: () => {},
    }),
  ).rejects.toThrow("new configuration remains installed");
  expect(deleted).toEqual([`${serverUrl}/v1/keys/000000000001`]);
  expect(await readFile(target.file, "utf8")).toContain(token("000000000002"));
});

test.each([
  {
    reason: "human admin",
    kind: "human",
    name: "matrix-mcp:claude-code:travel",
    projects: ["travel"],
    actions: ["admin"],
  },
  {
    reason: "agent admin",
    kind: "agent",
    name: "matrix-mcp:claude-code:travel",
    projects: ["travel"],
    actions: ["admin"],
  },
  {
    reason: "other project",
    kind: "agent",
    name: "matrix-mcp:claude-code:travel",
    projects: ["work"],
    actions: ["read"],
  },
  {
    reason: "other agent",
    kind: "agent",
    name: "matrix-mcp:codex:travel",
    projects: ["travel"],
    actions: ["read"],
  },
  {
    reason: "legacy unowned name",
    kind: "agent",
    name: "orca-claude-code",
    projects: ["travel"],
    actions: ["read"],
  },
  {
    reason: "multiple projects",
    kind: "agent",
    name: "matrix-mcp:claude-code:travel",
    projects: ["travel", "work"],
    actions: ["read"],
  },
  {
    reason: "global scope",
    kind: "agent",
    name: "matrix-mcp:claude-code:travel",
    projects: "*",
    actions: ["read"],
  },
])(
  "copied $reason key is never revoked",
  async ({ reason: _reason, kind, name, projects, actions }) => {
    const home = await mkdtemp(join(tmpdir(), "matrix-copied-key-"));
    const target = mcpConfigFor(
      "claude-code",
      home,
      `${serverUrl}/mcp`,
      token("000000000001"),
      "travel",
    );
    await writeFile(target.file, target.merge(""));
    const requests: string[] = [];
    const logs: string[] = [];
    const fetchImpl = (async (input, init) => {
      requests.push(`${init?.method} ${input}`);
      if (init?.method === "GET")
        return new Response(
          JSON.stringify([{ id: "000000000001", kind, name, scope: { projects, actions } }]),
        );
      return new Response(
        JSON.stringify({ token: token("000000000002"), key: { id: "000000000002" } }),
      );
    }) as typeof fetch;
    await registerMcp({
      serverUrl,
      home,
      agents: ["claude-code"],
      projects: ["travel"],
      actions: ["read"],
      adminKey: "admin",
      apply: true,
      fetchImpl,
      log: (line) => logs.push(line),
    });
    expect(requests).toEqual([`POST ${serverUrl}/v1/keys`, `GET ${serverUrl}/v1/keys`]);
    expect(logs.join("\n")).toContain("warning: skipped revocation of key 000000000001");
    expect(await readFile(target.file, "utf8")).toContain(token("000000000002"));
  },
);

test.each(["unavailable", "malformed", "missing"])(
  "metadata %s fails closed without deleting a key",
  async (failure) => {
    const home = await mkdtemp(join(tmpdir(), "matrix-metadata-"));
    const target = mcpConfigFor("codex", home, `${serverUrl}/mcp`, token("000000000001"), "travel");
    await mkdir(join(home, ".codex"));
    await writeFile(target.file, target.merge(""));
    const deleted: string[] = [];
    const logs: string[] = [];
    const fetchImpl = (async (input, init) => {
      if (init?.method === "GET")
        return failure === "unavailable"
          ? new Response("{}", { status: 403 })
          : new Response(failure === "malformed" ? "not json" : "[]");
      if (init?.method === "DELETE") deleted.push(String(input));
      return new Response(
        JSON.stringify({ token: token("000000000002"), key: { id: "000000000002" } }),
      );
    }) as typeof fetch;
    await registerMcp({
      serverUrl,
      home,
      agents: ["codex"],
      projects: ["travel"],
      actions: ["read"],
      adminKey: "admin",
      apply: true,
      fetchImpl,
      log: (line) => logs.push(line),
    });
    expect(deleted).toEqual([]);
    expect(logs.join("\n")).toContain("warning: skipped revocation of key 000000000001");
  },
);

test("unsafe IDs fail before requests or writes", async () => {
  for (const project of ["../travel", "travel.dot", "travel\n[evil]", "", "*"]) {
    await expect(
      registerMcp({
        serverUrl,
        home: "/tmp",
        agents: ["codex"],
        projects: [project],
        actions: ["read"],
        apply: false,
      }),
    ).rejects.toThrow("safe");
  }
});

test("CLI accepts repeated and comma-separated projects without changing legacy entries", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-cli-"));
  await mkdir(join(home, ".codex"));
  const file = join(home, ".codex", "config.toml");
  const original = '[mcp_servers.matrix]\nurl = "legacy"\n';
  await writeFile(file, original);
  expect(
    await orcaCommand([
      "register-mcp",
      "--server",
      serverUrl,
      "--agents",
      "codex",
      "--home",
      home,
      "--project",
      "travel,work",
      "--project",
      "third",
    ]),
  ).toBe(0);
  expect(await readFile(file, "utf8")).toBe(original);
});
