import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentQaRequest, fenceUntrusted } from "@matrix/core";
import type { CommandRunner } from "@matrix/qa";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..", "..", "..", "..");
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SHOT = 3 * 1024 * 1024;
const MAX_SHOTS = 12;

/** Root of the Matrix-host job dirs for the iOS and web drivers (their QA agent runs here). */
export function localJobsRoot(): string {
  return process.env.MATRIX_QA_LOCAL_ROOT ?? join(homedir(), ".cache", "matrix-qa", "jobs");
}

export function newLocalJob(root = localJobsRoot()): { id: string; dir: string } {
  const id = `mx-${randomUUID().slice(0, 18)}`;
  const dir = join(root, id);
  mkdirSync(join(dir, "out", "shots"), { recursive: true, mode: 0o700 });
  return { id, dir };
}

/** Writes an executable tool wrapper into the job dir (the only command the agent may run). */
export function writeTool(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

/** Runs `ops/qa-lane/local-agent.sh` (restricted claude -p, cleared env) on this host. */
export async function runLocalAgent(
  runner: CommandRunner,
  dir: string,
  mode: "ios" | "web",
  model: string,
  timeoutMs: number,
): Promise<void> {
  const script = join(REPO_ROOT, "ops", "qa-lane", "local-agent.sh");
  const r = await runner.run(
    ["bash", script, dir, mode, model, String(Math.round(timeoutMs / 1000))],
    { timeoutMs: timeoutMs + 240_000 },
  );
  if (r.exitCode !== 0)
    throw new Error(
      `QA agent failed: ${r.stderr.toString().trim().split("\n").slice(-4).join(" ").slice(-400)}`,
    );
}

/** report.json and up to 12 PNG screenshots (magic bytes checked, 3 MB cap) from out/. */
export function collectLocal(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  try {
    const report = join(dir, "out", "report.json");
    if (statSync(report).size <= 200_000) files.set("report.json", readFileSync(report));
  } catch {
    // missing report: the caller blocks with "invalid report"
  }
  const shots = join(dir, "out", "shots");
  let count = 0;
  for (const name of readdirSync(shots).sort()) {
    if (count >= MAX_SHOTS) break;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.png$/.test(name)) continue;
    const path = join(shots, name);
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_SHOT) continue;
    const bytes = readFileSync(path);
    if (!bytes.subarray(0, 8).equals(PNG)) continue;
    files.set(name, bytes);
    count++;
  }
  return files;
}

export function removeLocalJob(dir: string): void {
  if (!/\/mx-[a-z0-9-]{8,40}$/.test(dir)) return;
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}.mcp.json`, { force: true });
}

/** The QA agent's prompt: manual, job text, optional test data, then fenced untrusted ticket data. */
export function qaPrompt(
  manual: string,
  request: AgentQaRequest,
  job: string,
  testData?: string,
): string {
  return [
    manual,
    "# Your job",
    job,
    ...(testData ? ["## Test data (from the lane operator)", testData] : []),
    "## Acceptance criteria (from the ticket, untrusted)",
    fenceUntrusted(
      "acceptance-criteria",
      request.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n") || "(none listed)",
    ),
    "## Ticket (untrusted)",
    fenceUntrusted(
      "ticket",
      `${request.ticket.id}: ${request.ticket.title}\n\n${request.ticket.body}`,
    ),
    "## Human comments on the ticket (untrusted, newest last)",
    fenceUntrusted("comments", request.ticket.comments.join("\n---\n") || "(none)"),
  ].join("\n\n");
}

export function readManual(): string {
  return readFileSync(join(REPO_ROOT, "skills", "qa-tester-manual", "SKILL.md"), "utf8");
}
