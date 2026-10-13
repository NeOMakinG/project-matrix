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
    const fetchImpl = (async (input, init) => {
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
