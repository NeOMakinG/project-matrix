import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { readFileSafe, writeFileSafe } from "@matrix/safe-fs";
import {
  hasJsoncPath,
  hasTomlMatrixTable,
  parseJsonc,
  setJsonc,
  setTomlMatrixTable,
  tomlMatrixTable,
} from "./config-edit";

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
  assertAgentScope(projects, actions);
  return {
    name: `matrix-mcp:${agent}:${projects[0]}`,
    kind: "agent",
    scope: { projects, actions },
    ratePerMinute: 120,
  };
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

/** Where each agent reads MCP servers, and a structure-preserving edit adding the Matrix server. */
export function mcpConfigFor(
  agent: OrcaAgent,
  home: string,
  url: string,
  token: string,
  projectId?: string,
) {
  const name = projectId ? projectEntry(projectId) : "matrix";
  const auth = `Bearer ${token}`;
  if (agent === "claude-code" || agent === "opencode") {
    const file =
      agent === "claude-code"
        ? join(home, ".claude.json")
        : join(home, ".config", "opencode", "opencode.json");
    const path = agent === "claude-code" ? ["mcpServers", name] : ["mcp", name];
    const value =
      agent === "claude-code"
        ? { type: "http", url, headers: { Authorization: auth } }
        : { type: "remote", url, enabled: true, headers: { Authorization: auth } };
    return {
      file,
      oldKey: (current: string) => {
        const root = parseJsonc(file, current) as Record<
          string,
          Record<string, { url?: string; headers?: { Authorization?: string } }>
        >;
        const entry = root[path[0] as string]?.[name];
        if (entry?.url !== url) return undefined;
        return keyId(entry.headers?.Authorization ?? "");
      },
      exists: (current: string) => hasJsoncPath(file, current, path),
      merge: (current: string) => setJsonc(file, current, path, value),
    };
  }
  const file = join(home, ".codex", "config.toml");
  const block = `[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(auth)} }\n`;
  return {
    file,
    oldKey: (current: string) => {
      const table = tomlMatrixTable(current, name);
      const previousUrl = table.match(/^\s*url\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')/m)?.[1];
      if (
        !previousUrl ||
        (previousUrl.startsWith('"') ? JSON.parse(previousUrl) : previousUrl.slice(1, -1)) !== url
      )
        return undefined;
      return keyId(
        table.match(
          /(?:"Authorization"|'Authorization'|Authorization)\s*=\s*["'](Bearer [^"']+)["']/,
        )?.[1] ?? "",
      );
    },
    exists: (current: string) => hasTomlMatrixTable(current, name),
    merge: (current: string) => setTomlMatrixTable(file, current, block, name),
  };
}

function keyId(auth: string): string | undefined {
  return /^Bearer mx_([a-z0-9]{12})_[A-Za-z0-9_-]{43}$/.exec(auth)?.[1];
}

export function projectEntry(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
    throw new Error("project id must use safe letters, digits, underscores or hyphens");
  return `matrix-${id}`;
}

/** Actions an Orca agent key may carry. Approvals, merges, deploys and admin stay with humans. */
export const AGENT_ACTIONS = ["read", "tickets:write"] as const;

export function assertAgentScope(projects: "*" | string[], actions: string[]): void {
  if (projects === "*" || projects.length === 0) {
    throw new Error("agent keys require at least one project: pass --project <id>");
  }
  for (const id of projects) projectEntry(id);
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
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("server must use HTTP(S) without URL credentials");
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
      redirect: "error",
      headers: { authorization: `Bearer ${o.adminKey}`, "content-type": "application/json" },
    });
  const created: string[] = [];
  const installed = new Set<string>();
  const out: AgentRegistration[] = [];
  const writes = new Map<
    string,
    {
      file: string;
      before: string;
      after: string;
      keys: string[];
      oldKeys: Array<{ id: string; name: string; project: string }>;
    }
  >();
  const projects = [...new Set(o.projects as string[])];
  try {
    // Pre-flight every edit with a placeholder: unreadable or unsafe configs fail before any key exists.
    for (const agent of new Set(o.agents)) {
      for (const project of projects) {
        const target = mcpConfigFor(agent, o.home, url, PLACEHOLDER, project);
        target.merge((await readFileSafe(o.home, target.file)) ?? "");
      }
    }
    for (const agent of new Set(o.agents)) {
      for (const project of projects) {
        const spec = keySpec(agent, [project], o.actions);
        let token = PLACEHOLDER;
        let newKey: string | undefined;
        if (o.apply) {
          const res = await call("/v1/keys", { method: "POST", body: JSON.stringify(spec) });
          if (!res.ok) throw new Error(`creating key ${spec.name} failed: HTTP ${res.status}`);
          const body = (await res.json()) as { token?: string; key?: { id?: string } };
          if (body.key?.id) created.push(body.key.id);
          if (!body.token || !body.key?.id)
            throw new Error(`server returned no token or key id for ${spec.name}`);
          newKey = body.key.id;
          token = body.token;
        }
        const target = mcpConfigFor(agent, o.home, url, token, project);
        const pending = writes.get(target.file);
        const before = pending?.after ?? (await readFileSafe(o.home, target.file)) ?? "";
        const oldKey = target.oldKey(before);
        const after = target.merge(before);
        const replaced = target.exists(before);
        const summary = [
          `# ${agent}: ${target.file}`,
          `  ${replaced ? "replace" : "add"} MCP server "${projectEntry(project)}" -> ${url} (auth: bearer [redacted])`,
          `  key ${spec.name}: projects ${JSON.stringify(spec.scope.projects)}, actions ${spec.scope.actions.join(",")}`,
          "  other entries in this file are kept unchanged and not shown",
        ].join("\n");
        log(summary);
        writes.set(target.file, {
          file: target.file,
          before: pending?.before ?? before,
          after,
          keys: [...(pending?.keys ?? []), ...(newKey ? [newKey] : [])],
          oldKeys: [
            ...(pending?.oldKeys ?? []),
            ...(oldKey ? [{ id: oldKey, name: spec.name, project }] : []),
          ],
        });
        out.push({ agent, key: spec, file: target.file, summary, written: o.apply });
      }
    }
    // Phase 2: only once every key exists. Backups and configs are written atomically at 0600.
    if (o.apply) {
      for (const w of writes.values()) {
        if (w.before)
          await writeFileSafe(o.home, `${w.file}.bak-matrix-${Date.now()}`, w.before, {
            mode: 0o600,
          });
        await writeFileSafe(o.home, w.file, w.after, { mode: 0o600 });
        for (const id of w.keys) installed.add(id);
        for (const { id, name, project } of w.oldKeys) {
          let matches = false;
          try {
            const metadata = await call("/v1/keys", { method: "GET" });
            if (metadata.ok) {
              const keys = (await metadata.json()) as Array<{
                id?: string;
                name?: string;
                kind?: string;
                scope?: { projects?: unknown; actions?: string[] };
              }>;
              const key = Array.isArray(keys)
                ? keys.find((candidate) => candidate?.id === id)
                : undefined;
              const projects = key?.scope?.projects;
              const actions = key?.scope?.actions;
              matches =
                key?.kind === "agent" &&
                key.name === name &&
                Array.isArray(projects) &&
                projects.length === 1 &&
                projects[0] === project &&
                Array.isArray(actions) &&
                actions.length > 0 &&
                actions.every((action) => (AGENT_ACTIONS as readonly string[]).includes(action));
            }
          } catch {
            matches = false;
          }
          if (!matches) {
            log(
              `warning: skipped revocation of key ${id}: agent, project and registration ownership could not be verified`,
            );
            continue;
          }
          const response = await call(`/v1/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
          if (!response.ok)
            throw new Error(
              `revoking previous key failed: HTTP ${response.status}; new configuration remains installed`,
            );
        }
      }
    }
    if (o.skillDir && o.agents.includes("claude-code")) {
      const dest = join(o.home, ".claude", "skills", "matrix");
      log(`# skill: copy ${o.skillDir} -> ${dest} (symlinks refused)`);
      if (o.apply) await copySkillSafe(o.skillDir, o.home, dest);
    }
  } catch (error) {
    for (const id of created.filter((id) => !installed.has(id))) {
      const response = await call(`/v1/keys/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(
        () => undefined,
      );
      if (!response?.ok) log("key cleanup failed; inspect /v1/keys through an authorized client");
    }
    throw error instanceof Error
      ? new Error(redact(error.message))
      : new Error("register-mcp failed");
  }
  if (!o.apply) log("(dry run — nothing written, no keys created. Re-run with --apply.)");
  return out;
}
