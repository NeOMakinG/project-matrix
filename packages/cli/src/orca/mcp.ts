import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { readFileSafe, writeFileSafe } from "@matrix/safe-fs";

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

/** Redacts anything secret-shaped: bearer tokens, key-ish assignments, common token prefixes. */
export function redact(text: string): string {
  return text
    .replace(/(Bearer\s+)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/\b(mx_|sk-|ghp_|gho_|github_pat_|xox[bp]-)[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(
      /((?:token|secret|password|passwd|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      "$1[redacted]",
    );
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

/** Actions an Orca agent key may carry. Approvals, merges, deploys and admin stay with humans. */
export const AGENT_ACTIONS = ["read", "tickets:write"] as const;

export function assertAgentScope(projects: "*" | string[], actions: string[]): void {
  if (projects === "*" || projects.length !== 1) {
    throw new Error("agent keys are scoped to exactly one project: pass --project <id>");
  }
  for (const action of actions) {
    if (!(AGENT_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(
        `action ${action} is not allowed for agent keys (allowed: ${AGENT_ACTIONS.join(", ")})`,
      );
    }
  }
}

/** The admin key only travels over https, or plain http to loopback / a Tailscale 100.64/10 address when allowed. */
export function assertSafeTransport(serverUrl: string, allowTailnetHttp: boolean): void {
  const url = new URL(serverUrl);
  if (url.protocol === "https:") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return;
  const tailnet =
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host) || host.endsWith(".ts.net");
  if (tailnet && allowTailnetHttp) return;
  throw new Error(
    `refusing to send the admin key over plain http to ${host}; use https${tailnet ? " or --allow-tailnet-http" : ""}`,
  );
}

/** Copies a skill directory below `destBase` without following or creating symlinks. */
export async function copySkillSafe(src: string, destBase: string, dest: string): Promise<void> {
  for (const entry of await readdir(src, { withFileTypes: true, recursive: true })) {
    const full = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing to copy symlink ${full}`);
    if (!entry.isFile()) continue;
    const content = await readFileSafe(src, full);
    if (content === null) continue;
    await writeFileSafe(destBase, join(dest, relative(src, full)), content, { mode: 0o644 });
  }
}

export interface RegisterMcpOptions {
  serverUrl: string;
  adminKey?: string;
  agents: OrcaAgent[];
  projects: "*" | string[];
  actions: string[];
  home: string;
  skillDir?: string;
  apply: boolean;
  allowTailnetHttp?: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface AgentRegistration {
  agent: OrcaAgent;
  key: AgentKeySpec;
  file: string;
  /** Structural summary of what Matrix adds/changes. Never contains existing config values. */
  summary: string;
  written: boolean;
}

/** Dry-run by default. With `apply`: creates scoped keys, writes configs atomically at 0600, revokes keys on failure. */
export async function registerMcp(o: RegisterMcpOptions): Promise<AgentRegistration[]> {
  assertAgentScope(o.projects, o.actions);
  if (o.apply) {
    if (!o.adminKey) throw new Error("MATRIX_ADMIN_KEY is required with --apply");
    assertSafeTransport(o.serverUrl, o.allowTailnetHttp ?? false);
  }
  const log = (line: string) => (o.log ?? console.log)(redact(line));
  const base = o.serverUrl.replace(/\/$/, "");
  const url = `${base}/mcp`;
  const call = (path: string, init: RequestInit) =>
    (o.fetchImpl ?? fetch)(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${o.adminKey}`, "content-type": "application/json" },
    });
  const created: string[] = [];
  const out: AgentRegistration[] = [];
  const writes: Array<{ file: string; before: string; after: string }> = [];
  try {
    for (const agent of o.agents) {
      const spec = keySpec(agent, o.projects, o.actions);
      let token = PLACEHOLDER;
      if (o.apply) {
        const res = await call("/v1/keys", { method: "POST", body: JSON.stringify(spec) });
        if (!res.ok) throw new Error(`creating key ${spec.name} failed: HTTP ${res.status}`);
        const body = (await res.json()) as { token?: string; key?: { id?: string } };
        if (body.key?.id) created.push(body.key.id);
        if (!body.token) throw new Error(`server returned no token for ${spec.name}`);
        token = body.token;
      }
      const target = mcpConfigFor(agent, o.home, url, token);
      const before = (await readFileSafe(o.home, target.file)) ?? "";
      const after = target.merge(before);
      const replaced = /"matrix"\s*:|\[mcp_servers\.matrix\]/.test(before);
      const summary = [
        `# ${agent}: ${target.file}`,
        `  ${replaced ? "replace" : "add"} MCP server "matrix" -> ${url} (auth: bearer [redacted])`,
        `  key ${spec.name}: projects ${JSON.stringify(spec.scope.projects)}, actions ${spec.scope.actions.join(",")}`,
        "  other entries in this file are kept unchanged and not shown",
      ].join("\n");
      log(summary);
      writes.push({ file: target.file, before, after });
      out.push({ agent, key: spec, file: target.file, summary, written: o.apply });
    }
    // Phase 2: only once every key exists. Backups and configs are written atomically at 0600.
    if (o.apply) {
      for (const w of writes) {
        if (w.before)
          await writeFileSafe(o.home, `${w.file}.bak-matrix-${Date.now()}`, w.before, {
            mode: 0o600,
          });
        await writeFileSafe(o.home, w.file, w.after, { mode: 0o600 });
      }
    }
    if (o.skillDir && o.agents.includes("claude-code")) {
      const dest = join(o.home, ".claude", "skills", "matrix");
      log(`# skill: copy ${o.skillDir} -> ${dest} (symlinks refused)`);
      if (o.apply) await copySkillSafe(o.skillDir, o.home, dest);
    }
  } catch (error) {
    for (const id of created)
      await call(`/v1/keys/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    if (created.length) log(`revoked ${created.length} key(s) created before the failure`);
    throw error;
  }
  if (!o.apply) log("(dry run — nothing written, no keys created. Re-run with --apply.)");
  return out;
}
