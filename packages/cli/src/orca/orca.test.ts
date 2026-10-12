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

describe("register-mcp", () => {
  test("dry run makes no API calls and writes nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "mx-home-"));
    let calls = 0;
    const out = await registerMcp({
      serverUrl: "http://matrix:8787",
      agents: ["claude-code", "codex", "opencode"],
      projects: "*",
      actions: ["read", "tickets:write"],
      home,
      apply: false,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}");
      }) as typeof fetch,
      log: () => {},
    });
    expect(calls).toBe(0);
    expect(out.every((r) => !r.written)).toBe(true);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(out[0]?.diff).toContain("http://matrix:8787/mcp");
  });

  test("apply creates one scoped agent key per agent, merges configs, redacts tokens", async () => {
    const home = await mkdtemp(join(tmpdir(), "mx-home-"));
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ theme: "dark", mcpServers: { other: { url: "x" } } }),
    );
    await mkdir(join(home, ".codex"));
    await writeFile(
      join(home, ".codex", "config.toml"),
      'model = "gpt"\n\n[mcp_servers.matrix]\nurl = "old"\n',
    );
    const bodies: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    await registerMcp({
      serverUrl: "http://matrix:8787",
      adminKey: "admin-key",
      agents: ["claude-code", "codex", "opencode"],
      projects: ["ledgerly"],
      actions: ["read"],
      home,
      apply: true,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        return new Response(JSON.stringify({ token: `mx_tok_${body.name}` }));
      }) as typeof fetch,
      log: (l) => logs.push(l),
    });
    expect(bodies.map((b) => b.name)).toEqual(["orca-claude-code", "orca-codex", "orca-opencode"]);
    expect(bodies[0]).toMatchObject({
      kind: "agent",
      scope: { projects: ["ledgerly"], actions: ["read"] },
    });
    const claude = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(claude.theme).toBe("dark");
    expect(claude.mcpServers.other).toEqual({ url: "x" });
    expect(claude.mcpServers.matrix.headers.Authorization).toBe("Bearer mx_tok_orca-claude-code");
    const codex = await readFile(join(home, ".codex", "config.toml"), "utf8");
    expect(codex).toContain('model = "gpt"');
    expect(codex.match(/\[mcp_servers\.matrix\]/g)).toHaveLength(1);
    expect(codex).not.toContain('url = "old"');
    const opencode = JSON.parse(
      await readFile(join(home, ".config", "opencode", "opencode.json"), "utf8"),
    );
    expect(opencode.mcp.matrix).toMatchObject({ type: "remote", url: "http://matrix:8787/mcp" });
    expect(logs.join("\n")).not.toContain("mx_tok_");
    expect(existsSync(join(home, ".claude", "skills", "matrix"))).toBe(false);
  });
});
