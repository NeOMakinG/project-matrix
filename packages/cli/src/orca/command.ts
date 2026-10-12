import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type HookPlan, installOrcaHooks, uninstallOrcaHooks } from "./hooks";
import { ORCA_AGENTS, type OrcaAgent, registerMcp } from "./mcp";

export const ORCA_USAGE = `matrix orca hooks install|uninstall [--apply] [--dir <abs>] [--server <url>] [--secret-file <file>]
  Writes ONLY Matrix-owned files under --dir (default ~/.matrix/orca) and prints the exact agent
  config change to make. Dry run unless --apply. Secret: --secret-file or MATRIX_ORCA_HOOK_SECRET.
matrix orca register-mcp [--apply] --server <url> [--agents claude-code,codex,opencode]
                         --project <id> [--actions read,tickets:write] [--home <dir>]
                         [--allow-tailnet-http]
  Gives each agent the Matrix MCP server with its own scoped API key (needs MATRIX_ADMIN_KEY with
  --apply; https, or http to loopback / Tailscale with --allow-tailnet-http) and installs the matrix
  skill for Claude Code. Dry run unless --apply. Shows only what Matrix adds; configs written 0600.`;

const DEFAULT_SKILL = fileURLToPath(new URL("../../../../skills/matrix-init", import.meta.url));

function printPlan(plan: HookPlan): void {
  console.log(
    plan.apply ? "Wrote Matrix-owned files:" : "Would write Matrix-owned files (dry run):",
  );
  for (const f of plan.files) console.log(`  ${f.path} (${f.mode}) — ${f.note}`);
  console.log("\nAgent config changes to make yourself (Matrix never edits them):");
  for (const c of plan.changes) console.log(`\n# ${c.agent}: ${c.file}\n${c.change}`);
  console.log(`\nEvents forwarded: ${plan.events.join(", ")}`);
}

export async function orcaCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      apply: { type: "boolean", default: false },
      dir: { type: "string" },
      server: { type: "string" },
      "secret-file": { type: "string" },
      agents: { type: "string" },
      project: { type: "string" },
      "allow-tailnet-http": { type: "boolean", default: false },
      actions: { type: "string" },
      home: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [group, action] = positionals;
  if (values.help || !group) {
    console.log(ORCA_USAGE);
    return values.help ? 0 : 1;
  }
  const server = values.server ?? process.env.MATRIX_URL;
  if (group === "hooks" && (action === "install" || action === "uninstall")) {
    const dir = values.dir ?? join(homedir(), ".matrix", "orca");
    if (action === "uninstall") {
      printPlan(await uninstallOrcaHooks({ dir, apply: values.apply }));
      return 0;
    }
    const secretFile = values["secret-file"];
    const secret = secretFile
      ? (await readFile(secretFile, "utf8")).trim()
      : process.env.MATRIX_ORCA_HOOK_SECRET;
    printPlan(
      await installOrcaHooks({
        dir,
        apply: values.apply,
        ...(server ? { serverUrl: server } : {}),
        ...(secret ? { secret } : {}),
      }),
    );
    return 0;
  }
  if (group === "register-mcp") {
    if (!server) throw new Error("--server (or MATRIX_URL) is required");
    const agents = (values.agents?.split(",") ?? ORCA_AGENTS) as OrcaAgent[];
    for (const a of agents) if (!ORCA_AGENTS.includes(a)) throw new Error(`unknown agent ${a}`);
    if (!values.project)
      throw new Error("--project <id> is required: agent keys are scoped to one project");
    await registerMcp({
      serverUrl: server,
      agents,
      projects: [values.project],
      allowTailnetHttp: values["allow-tailnet-http"],
      actions: values.actions?.split(",") ?? ["read", "tickets:write"],
      home: values.home ?? homedir(),
      skillDir: DEFAULT_SKILL,
      apply: values.apply,
      ...(process.env.MATRIX_ADMIN_KEY ? { adminKey: process.env.MATRIX_ADMIN_KEY } : {}),
    });
    return 0;
  }
  console.log(ORCA_USAGE);
  return 1;
}
