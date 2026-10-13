import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSafe } from "@matrix/safe-fs";
import { HOOK_STATUS } from "./sign";

export const HOOK_ASSET = fileURLToPath(
  new URL("../../assets/matrix-orca-hook.mjs", import.meta.url),
);
const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"];

export interface ConfigChange {
  agent: "claude-code" | "codex" | "opencode";
  file: string;
  change: string;
}

/** POSIX single-quote escaping: safe for any path in a shell command string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The exact agent-config edits that make an agent call the Matrix hook. Printed, never applied. */
export function hookConfigChanges(script: string): ConfigChange[] {
  const command = (agent: string) => `node ${shellQuote(script)} ${agent}`;
  const claude = Object.fromEntries(
    CLAUDE_EVENTS.map((e) => [
      e,
      [{ hooks: [{ type: "command", command: command("claude-code") }] }],
    ]),
  );
  return [
    {
      agent: "claude-code",
      file: '~/.claude/settings.json (merge into "hooks", next to Orca\'s managed hooks)',
      change: JSON.stringify({ hooks: claude }, null, 2),
    },
    {
      agent: "codex",
      file: "~/.codex/config.toml (Orca's codex runtime home uses its own copy; add it there too)",
      change: `notify = ["node", ${JSON.stringify(script)}, "codex"]`,
    },
    {
      agent: "opencode",
      file: "~/.config/opencode/plugin/matrix.js",
      change: [
        'import { execFile } from "node:child_process";',
        "export const Matrix = async () => ({",
        "  event: async ({ event }) => {",
        `    const map = { "session.idle": "Stop", "session.created": "SessionStart" };`,
        "    const name = map[event.type];",
        `    if (name) execFile("node", [${JSON.stringify(script)}, "opencode", JSON.stringify({ hook_event_name: name })]);`,
        "  },",
        "});",
      ].join("\n"),
    },
  ];
}

export interface HookFilesOptions {
  /** Matrix-owned directory, e.g. ~/.matrix/orca. Nothing outside it is ever written. */
  dir: string;
  serverUrl?: string;
  secret?: string;
  apply: boolean;
}

export interface HookPlan {
  apply: boolean;
  files: Array<{ path: string; mode: string; note: string }>;
  changes: ConfigChange[];
  events: string[];
}

async function assertNotSymlink(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat?.isSymbolicLink()) throw new Error(`refusing to write through symlink ${path}`);
}

export async function installOrcaHooks(o: HookFilesOptions): Promise<HookPlan> {
  if (!isAbsolute(o.dir)) throw new Error("--dir must be absolute");
  const script = join(o.dir, "matrix-orca-hook.mjs");
  const env = join(o.dir, "hook.env");
  const plan: HookPlan = {
    apply: o.apply,
    files: [
      { path: script, mode: "0755", note: "hook script (posts signed status to /hooks/orca)" },
      { path: env, mode: "0600", note: "MATRIX_URL + hook secret (secret never printed)" },
    ],
    changes: hookConfigChanges(script),
    events: Object.keys(HOOK_STATUS),
  };
  if (!o.apply) return plan;
  if (!o.serverUrl || !/^https?:\/\//.test(o.serverUrl))
    throw new Error("--server <http(s) url> is required with --apply");
  if (!o.secret || o.secret.length < 16)
    throw new Error("a hook secret (>= 16 chars) is required with --apply");
  if (/[\r\n]/.test(o.serverUrl + o.secret))
    throw new Error("server url and secret must be single-line");
  const base = dirname(o.dir);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await writeFileSafe(base, script, await readFile(HOOK_ASSET), { mode: 0o755 });
  await writeFileSafe(base, env, `MATRIX_URL=${o.serverUrl}\nMATRIX_ORCA_SECRET=${o.secret}\n`, {
    mode: 0o600,
  });
  await chmod(env, 0o600);
  return plan;
}

export async function uninstallOrcaHooks(o: { dir: string; apply: boolean }): Promise<HookPlan> {
  const plan = await installOrcaHooks({ dir: o.dir, apply: false });
  if (o.apply) {
    for (const f of plan.files) {
      await assertNotSymlink(f.path);
      await rm(f.path, { force: true });
    }
  }
  return { ...plan, apply: o.apply };
}
