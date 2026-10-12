import { copyFile, cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type OrcaAgent = "claude-code" | "codex" | "opencode";
export const ORCA_AGENTS: OrcaAgent[] = ["claude-code", "codex", "opencode"];
const PLACEHOLDER = "<token created on --apply>";

export interface AgentKeySpec {
  name: string;
  kind: "agent";
  scope: { projects: "*" | string[]; actions: string[] };
  ratePerMinute: number;
}

export function keySpec(
  agent: OrcaAgent,
  projects: "*" | string[],
  actions: string[],
): AgentKeySpec {
  return { name: `orca-${agent}`, kind: "agent", scope: { projects, actions }, ratePerMinute: 120 };
}

export function redact(text: string): string {
  return text.replace(/(Bearer )[^\s"']+/g, "$1[redacted]");
}

/** Where each agent reads MCP servers, and the merged file content for the Matrix server. */
export function mcpConfigFor(agent: OrcaAgent, home: string, url: string, token: string) {
  const auth = `Bearer ${token}`;
  if (agent === "claude-code") {
    return {
      file: join(home, ".claude.json"),
      merge: (current: string) => {
        const doc = current.trim() ? (JSON.parse(current) as Record<string, unknown>) : {};
        const servers = (doc.mcpServers as Record<string, unknown> | undefined) ?? {};
        servers.matrix = { type: "http", url, headers: { Authorization: auth } };
        return `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`;
      },
    };
  }
  if (agent === "opencode") {
    return {
      file: join(home, ".config", "opencode", "opencode.json"),
      merge: (current: string) => {
        const doc = current.trim() ? (JSON.parse(current) as Record<string, unknown>) : {};
        const mcp = (doc.mcp as Record<string, unknown> | undefined) ?? {};
        mcp.matrix = { type: "remote", url, enabled: true, headers: { Authorization: auth } };
        return `${JSON.stringify({ ...doc, mcp }, null, 2)}\n`;
      },
    };
  }
  return {
    file: join(home, ".codex", "config.toml"),
    merge: (current: string) => {
      const block = `[mcp_servers.matrix]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(auth)} }\n`;
      const without = current.replace(/\n?\[mcp_servers\.matrix\][^[]*/s, "\n");
      return `${without.trimEnd()}\n\n${block}`;
    },
  };
}

/** Minimal line diff (removed `-`, added `+`), enough to review a config change before writing. */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const removed = a.filter((l) => !b.includes(l)).map((l) => `- ${l}`);
  const added = b.filter((l) => !a.includes(l)).map((l) => `+ ${l}`);
  return [...removed, ...added].join("\n");
}

export interface RegisterMcpOptions {
  serverUrl: string;
  adminKey?: string;
  agents: OrcaAgent[];
  projects: "*" | string[];
  actions: string[];
  home: string;
  /** Directory of the `matrix` skill to install for Claude Code (`~/.claude/skills/<name>`). */
  skillDir?: string;
  apply: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface AgentRegistration {
  agent: OrcaAgent;
  key: AgentKeySpec;
  file: string;
  diff: string;
  written: boolean;
}

async function createKey(o: RegisterMcpOptions, spec: AgentKeySpec): Promise<string> {
  const res = await (o.fetchImpl ?? fetch)(`${o.serverUrl.replace(/\/$/, "")}/v1/keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${o.adminKey}`, "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
  if (!res.ok) throw new Error(`creating key ${spec.name} failed: HTTP ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error(`server returned no token for ${spec.name}`);
  return body.token;
}

/** Dry-run by default: prints key specs and redacted diffs. `apply` creates keys, shows diffs, then writes (with a .bak). */
export async function registerMcp(o: RegisterMcpOptions): Promise<AgentRegistration[]> {
  if (!/^https?:\/\//.test(o.serverUrl)) throw new Error("--server must be an http(s) url");
  if (o.apply && !o.adminKey) throw new Error("MATRIX_ADMIN_KEY is required with --apply");
  const log = o.log ?? console.log;
  const url = `${o.serverUrl.replace(/\/$/, "")}/mcp`;
  const out: AgentRegistration[] = [];
  for (const agent of o.agents) {
    const spec = keySpec(agent, o.projects, o.actions);
    const token = o.apply ? await createKey(o, spec) : PLACEHOLDER;
    const target = mcpConfigFor(agent, o.home, url, token);
    const stat = await lstat(target.file).catch(() => undefined);
    if (stat?.isSymbolicLink()) throw new Error(`refusing to edit symlinked config ${target.file}`);
    const before = stat ? await readFile(target.file, "utf8") : "";
    const after = target.merge(before);
    const diff = redact(lineDiff(before, after));
    log(
      `\n# ${agent}: ${target.file}\n# key ${spec.name} scope ${JSON.stringify(spec.scope)}\n${diff}`,
    );
    if (o.apply) {
      await mkdir(dirname(target.file), { recursive: true });
      if (stat) await copyFile(target.file, `${target.file}.bak-matrix-${Date.now()}`);
      await writeFile(target.file, after, { mode: 0o600 });
    }
    out.push({ agent, key: spec, file: target.file, diff, written: o.apply });
  }
  if (o.skillDir && o.agents.includes("claude-code")) {
    const dest = join(o.home, ".claude", "skills", "matrix");
    log(`\n# skill: copy ${o.skillDir} -> ${dest}`);
    if (o.apply)
      await cp(o.skillDir, dest, { recursive: true, dereference: false, errorOnExist: false });
  }
  if (!o.apply)
    log(
      "\n(dry run — nothing written. Re-run with --apply to create keys and write these changes.)",
    );
  return out;
}
