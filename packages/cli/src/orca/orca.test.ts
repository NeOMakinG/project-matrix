import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function run(args: string[], input?: string, env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("node", args, { env: { PATH: process.env.PATH ?? "", ...env } }, (e) =>
      e ? reject(e) : resolve(),
    );
    child.stdin?.end(input ?? "");
  });
}

import { hmacHex, safeEqual } from "../../../../apps/server/src/webhooks";
import { hookConfigChanges, installOrcaHooks, uninstallOrcaHooks } from "./hooks";
import { registerMcp } from "./mcp";
import { signOrcaHook } from "./sign";

const SECRET = "orca-hook-secret-0123456789";

/** Same check as apps/server POST /hooks/orca. */
function serverAccepts(
  secret: string,
  body: string,
  h: Record<string, string | undefined>,
): boolean {
  const ts = h["x-orca-timestamp"];
  const nonce = h["x-orca-nonce"];
  if (!ts || !nonce || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return false;
  const expected = `sha256=${hmacHex(secret, `${ts}.${nonce}.${body}`)}`;
  return Boolean(h["x-orca-signature"] && safeEqual(expected, h["x-orca-signature"]));
}

describe("hook signature", () => {
  test("matches the server verifier; tampering fails", () => {
    const body = JSON.stringify({ worktree: "wt", agent: "claude-code", status: "idle" });
    const headers = signOrcaHook(SECRET, body);
    expect(serverAccepts(SECRET, body, headers)).toBe(true);
    expect(serverAccepts(SECRET, `${body} `, headers)).toBe(false);
    expect(serverAccepts("other-secret-0123456789", body, headers)).toBe(false);
    expect(() => signOrcaHook(SECRET, body, 1, "short")).toThrow();
  });

  test("installed hook script posts a request the server accepts", async () => {
    const received: Array<{ ok: boolean; body: Record<string, string> }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const h = req.headers as Record<string, string | undefined>;
        received.push({
          ok: req.url === "/hooks/orca" && serverAccepts(SECRET, body, h),
          body: JSON.parse(body),
        });
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = join(await mkdtemp(join(tmpdir(), "mx-orca-")), "orca");
    await installOrcaHooks({ dir, apply: true, serverUrl: url, secret: SECRET });
    const script = join(dir, "matrix-orca-hook.mjs");
    await run([script, "claude-code"], JSON.stringify({ hook_event_name: "Stop", cwd: "/x" }), {
      ORCA_WORKTREE_ID: "wt-42",
      MATRIX_RUN_ID: "run-7",
    });
    await run([script, "codex", JSON.stringify({ type: "agent-turn-complete" })]);
    await run([script, "claude-code"], "{bad json");
    server.close();
    expect(received).toHaveLength(2);
    expect(received.every((r) => r.ok)).toBe(true);
    expect(received[0]?.body).toMatchObject({
      worktree: "wt-42",
      agent: "claude-code",
      status: "idle",
      runId: "run-7",
    });
    expect(received[1]?.body).toMatchObject({ agent: "codex", status: "idle" });
  });
});

describe("hooks install/uninstall", () => {
  test("dry run writes nothing; apply writes only Matrix-owned files; uninstall removes them", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "mx-orca-")), "orca");
    const dry = await installOrcaHooks({ dir, apply: false });
    expect(existsSync(dir)).toBe(false);
    expect(dry.changes.map((c) => c.agent)).toEqual(["claude-code", "codex", "opencode"]);
    expect(dry.changes[0]?.change).toContain(join(dir, "matrix-orca-hook.mjs"));
    await installOrcaHooks({ dir, apply: true, serverUrl: "http://127.0.0.1:1", secret: SECRET });
    expect(statSync(join(dir, "hook.env")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(dry)).not.toContain(SECRET);
    await uninstallOrcaHooks({ dir, apply: true });
    expect(existsSync(join(dir, "hook.env"))).toBe(false);
  });

  test("refuses symlinks and missing secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "mx-orca-"));
    const dir = join(root, "orca");
    await mkdir(dir);
    await symlink("/etc/hosts", join(dir, "hook.env"));
    await expect(
      installOrcaHooks({ dir, apply: true, serverUrl: "http://x", secret: SECRET }),
    ).rejects.toThrow(/symlink/);
    await expect(
      installOrcaHooks({ dir: join(root, "o2"), apply: true, serverUrl: "http://x" }),
    ).rejects.toThrow(/secret/);
    expect(() => hookConfigChanges("rel")).not.toThrow();
  });
});

const tokenFetch = (bodies: Array<Record<string, unknown>>, failOn?: string) =>
  (async (url: string, init: RequestInit) => {
    if (init.method === "DELETE") {
      bodies.push({ deleted: url });
      return new Response("{}");
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    if (body.name === failOn) return new Response("{}", { status: 500 });
    return new Response(
      JSON.stringify({ token: `mx_tok_${body.name}`, key: { id: `id-${body.name}` } }),
    );
  }) as typeof fetch;

describe("register-mcp", () => {
  const base = {
    serverUrl: "https://matrix.example",
    agents: ["claude-code", "codex", "opencode"] as const,
  };

  test("dry run: no API calls, no writes, never echoes existing config values", async () => {
    const home = await mkdtemp(join(tmpdir(), "mx-home-"));
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { db: { env: { PGPASSWORD: "hunter2-super-secret" } } },
        oauthToken: "sk-live-abcdefghijkl",
      }),
    );
    const logs: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const out = await registerMcp({
      ...base,
      agents: [...base.agents],
      projects: ["ledgerly"],
      actions: ["read"],
      home,
      apply: false,
      fetchImpl: tokenFetch(bodies),
      log: (l) => logs.push(l),
    });
    expect(bodies).toHaveLength(0);
    expect(out.every((r) => !r.written)).toBe(true);
    const text = logs.join("\n") + JSON.stringify(out);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("sk-live");
    expect(text).toContain('MCP server "matrix-ledgerly" -> https://matrix.example/mcp');
  });

  test("apply: 0600 configs and backups, scoped keys, merged entries, no tokens logged", async () => {
    const home = await mkdtemp(join(tmpdir(), "mx-home-"));
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ theme: "dark", mcpServers: { other: { url: "x" } } }),
      { mode: 0o644 },
    );
    await mkdir(join(home, ".codex"));
    await writeFile(
      join(home, ".codex", "config.toml"),
      'model = "gpt"\n\n[mcp_servers.matrix-ledgerly]\nurl = "old"\n',
    );
    const bodies: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    await registerMcp({
      ...base,
      agents: [...base.agents],
      adminKey: "admin",
      projects: ["ledgerly"],
      actions: ["read", "tickets:write"],
      home,
      apply: true,
      fetchImpl: tokenFetch(bodies),
      log: (l) => logs.push(l),
    });
    expect(bodies.map((b) => b.name)).toEqual([
      "matrix-mcp:claude-code:ledgerly",
      "matrix-mcp:codex:ledgerly",
      "matrix-mcp:opencode:ledgerly",
    ]);
    expect(bodies[0]).toMatchObject({
      kind: "agent",
      scope: { projects: ["ledgerly"], actions: ["read", "tickets:write"] },
    });
    expect(statSync(join(home, ".claude.json")).mode & 0o777).toBe(0o600);
    const { readdirSync } = await import("node:fs");
    const bak = readdirSync(home).find((f) => f.startsWith(".claude.json.bak-matrix-"));
    expect(bak && statSync(join(home, bak)).mode & 0o777).toBe(0o600);
    const claude = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(claude.mcpServers.other).toEqual({ url: "x" });
    expect(claude.mcpServers["matrix-ledgerly"].headers.Authorization).toBe(
      "Bearer mx_tok_matrix-mcp:claude-code:ledgerly",
    );
    const codex = await readFile(join(home, ".codex", "config.toml"), "utf8");
    expect(codex.match(/\[mcp_servers\.matrix-ledgerly\]/g)).toHaveLength(1);
    expect(codex).not.toContain('url = "old"');
    expect(logs.join("\n")).not.toContain("mx_tok_");
  });

  test("a failure revokes every key created so far and writes nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "mx-home-"));
    const bodies: Array<Record<string, unknown>> = [];
    await expect(
      registerMcp({
        ...base,
        agents: [...base.agents],
        adminKey: "admin",
        projects: ["p"],
        actions: ["read"],
        home,
        apply: true,
        fetchImpl: tokenFetch(bodies, "matrix-mcp:opencode:p"),
        log: () => {},
      }),
    ).rejects.toThrow(/matrix-mcp:opencode:p/);
    expect(bodies.filter((b) => b.deleted).map((b) => String(b.deleted))).toEqual([
      "https://matrix.example/v1/keys/id-matrix-mcp%3Aclaude-code%3Ap",
      "https://matrix.example/v1/keys/id-matrix-mcp%3Acodex%3Ap",
    ]);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
  });

  test("scope and transport policy", async () => {
    const opts = { ...base, agents: ["codex" as const], home: "/tmp", apply: false, log: () => {} };
    await expect(registerMcp({ ...opts, projects: "*", actions: ["read"] })).rejects.toThrow(
      /one project/,
    );
    await expect(registerMcp({ ...opts, projects: ["p"], actions: ["merge"] })).rejects.toThrow(
      /not allowed/,
    );
    const apply = { ...opts, projects: ["p"], actions: ["read"], apply: true, adminKey: "a" };
    await expect(registerMcp({ ...apply, serverUrl: "http://matrix.example" })).rejects.toThrow(
      /plain http/,
    );
    await expect(registerMcp({ ...apply, serverUrl: "http://100.90.1.2:8787" })).rejects.toThrow(
      /allow-tailnet-http/,
    );
  });

  test("skill copy refuses symlinks", async () => {
    const { copySkillSafe } = await import("./mcp");
    const src = await mkdtemp(join(tmpdir(), "mx-skill-"));
    await writeFile(join(src, "SKILL.md"), "# skill");
    await symlink("/etc/hosts", join(src, "leak.md"));
    const home = await mkdtemp(join(tmpdir(), "mx-home-"));
    await expect(
      copySkillSafe(src, home, join(home, ".claude", "skills", "matrix")),
    ).rejects.toThrow(/symlink/);
  });
});

test("hook command shell-quotes the script path", async () => {
  const { shellQuote } = await import("./hooks");
  const changes = hookConfigChanges("/tmp/o'brien dir/$(touch x)/hook.mjs");
  expect(changes[0]?.change).toContain(
    JSON.stringify(`node ${shellQuote("/tmp/o'brien dir/$(touch x)/hook.mjs")} claude-code`).slice(
      1,
      -1,
    ),
  );
  expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
});

describe("round 2: parser errors and structure-preserving edits", () => {
  const opts = (home: string) => ({
    serverUrl: "https://matrix.example",
    projects: ["p"],
    actions: ["read"],
    home,
    apply: false,
    log: () => {},
  });

  test("PoC: a malformed config never surfaces its secret, even in dry run", async () => {
    const home = await mkdtemp(join(tmpdir(), "mx-home-"));
    await writeFile(join(home, ".claude.json"), '{"oauthToken": "sk-live-SUPERSECRET-123" "x": }');
    let message = "";
    try {
      await registerMcp({ ...opts(home), agents: ["claude-code"] });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/is not valid JSON at line 1, column \d+/);
    expect(message).not.toContain("SUPERSECRET");
    const cli = await new Promise<string>((resolve) => {
      execFile(
        "bun",
        [
          join(__dirname, "..", "bin.ts"),
          "orca",
          "register-mcp",
          "--server",
          "https://m.example",
          "--project",
          "p",
          "--agents",
          "claude-code",
          "--home",
          home,
        ],
        (_e, stdout, stderr) => resolve(stdout + stderr),
      );
    });
    expect(cli).toContain("is not valid JSON");
    expect(cli).not.toContain("SUPERSECRET");
  });

  test("OpenCode JSONC: comments and trailing commas survive the edit", async () => {
    const home = await mkdtemp(join(tmpdir(), "mx-home-"));
    const dir = join(home, ".config", "opencode");
    await mkdir(dir, { recursive: true });
    const original =
      '{\n  // my theme\n  "theme": "opencode",\n  "mcp": {\n    "other": { "type": "local" }, // keep me\n  },\n}\n';
    await writeFile(join(dir, "opencode.json"), original);
    const bodies: Array<Record<string, unknown>> = [];
    await registerMcp({
      ...opts(home),
      agents: ["opencode"],
      apply: true,
      adminKey: "a",
      fetchImpl: tokenFetch(bodies),
    });
    const after = await readFile(join(dir, "opencode.json"), "utf8");
    expect(after).toContain("// my theme");
    expect(after).toContain("// keep me");
    const { parse: parseJsonc } = await import("jsonc-parser");
    expect(parseJsonc(after).mcp.other).toEqual({ type: "local" });
    expect(parseJsonc(after).theme).toBe("opencode");
    expect(after).toContain('"matrix-p"');
  });

  test("Codex TOML: other tables and comments untouched; unsafe forms refused before any key", async () => {
    const home = await mkdtemp(join(tmpdir(), "mx-home-"));
    await mkdir(join(home, ".codex"));
    const toml =
      '# top comment\nmodel = "gpt"\n\n[mcp_servers.matrix-p]\nurl = "old"\n\n[profiles.fast]\nmodel = "mini" # inline\n';
    await writeFile(join(home, ".codex", "config.toml"), toml);
    const bodies: Array<Record<string, unknown>> = [];
    await registerMcp({
      ...opts(home),
      agents: ["codex"],
      apply: true,
      adminKey: "a",
      fetchImpl: tokenFetch(bodies),
    });
    const after = await readFile(join(home, ".codex", "config.toml"), "utf8");
    expect(after).toContain('# top comment\nmodel = "gpt"');
    expect(after).toContain('[profiles.fast]\nmodel = "mini" # inline');
    expect(after).not.toContain('url = "old"');
    expect(after.match(/\[mcp_servers\.matrix-p\]/g)).toHaveLength(1);

    const home2 = await mkdtemp(join(tmpdir(), "mx-home-"));
    await mkdir(join(home2, ".codex"));
    await writeFile(join(home2, ".codex", "config.toml"), 'x = """\n[mcp_servers.matrix]\n"""\n');
    const calls: Array<Record<string, unknown>> = [];
    await expect(
      registerMcp({
        ...opts(home2),
        agents: ["codex"],
        apply: true,
        adminKey: "a",
        fetchImpl: tokenFetch(calls),
      }),
    ).rejects.toThrow(/multi-line strings/);
    expect(calls).toHaveLength(0);
    await writeFile(join(home2, ".codex", "config.toml"), 'mcp_servers.matrix-p.url = "x"\n');
    await expect(registerMcp({ ...opts(home2), agents: ["codex"] })).rejects.toThrow(
      /can't edit safely/,
    );
  });
});
