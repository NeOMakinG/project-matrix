import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Receipt } from "@matrix/core";
import { gitLocation, safeGitEnv } from "./safe-git.js";

export interface SecretFinding {
  source: "gitleaks" | "value";
  rule: string;
  /** File path, or blob id for history-only content. Never the secret itself. */
  location: string;
  commit?: string;
}

export interface SecretGateOptions {
  /** Host-owned git dir (canonical `.git` or a bare clone). Never a path inside an agent worktree. */
  gitDir: string;
  /** Revisions to scan, e.g. `["origin/main..matrix/mx-1"]` for exactly what will be pushed. */
  revs?: string[];
  /** Known secret values (gateway key, tokens). Matched raw, base64 (std + url) and hex encoded. */
  secretValues?: Array<{ name: string; value: string }>;
  gitleaksBinary?: string;
  /** Skip gitleaks (e.g. not installed); value scanning still runs. */
  skipGitleaks?: boolean;
  /** Blobs larger than this are reported as findings instead of skipped. */
  maxBlobBytes?: number;
}

export interface SecretGateResult {
  ok: boolean;
  findings: SecretFinding[];
  blobsScanned: number;
  receipt: Receipt;
}

function run(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  input?: string,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";
    let size = 0;
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_GIT_OUTPUT) {
        child.kill("SIGKILL");
        reject(
          new Error(`${cmd} output exceeded ${MAX_GIT_OUTPUT} bytes; refusing to scan partially`),
        );
        return;
      }
      out.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr }));
    child.stdin.end(input ?? "");
  });
}

/** Every encoding of a secret we look for. Values shorter than 8 chars are ignored to avoid noise. */
/** Fail closed instead of buffering unbounded git output. */
export const MAX_GIT_OUTPUT = 1024 * 1024 * 1024;

export function secretNeedles(value: string): Buffer[] {
  if (value.length < 8) return [];
  const raw = Buffer.from(value);
  const variants = new Set<string>([
    value,
    raw.toString("base64"),
    raw.toString("base64").replace(/=+$/, ""),
    raw.toString("base64url"),
    raw.toString("hex"),
    raw.toString("hex").toUpperCase(),
  ]);
  return [...variants].map((v) => Buffer.from(v));
}

/** Host-owned gitleaks config: default rules, no allowlists. Repo `.gitleaks.toml` is never read. */
export const GITLEAKS_CONFIG = "[extend]\nuseDefault = true\n";

async function scanGitleaks(
  gitDir: string,
  revs: string[],
  binary: string,
): Promise<SecretFinding[]> {
  const dir = await mkdtemp(join(tmpdir(), "matrix-gitleaks-"));
  const report = join(dir, "report.json");
  const config = join(dir, "gitleaks.toml");
  const ignoreDir = await mkdtemp(join(dir, "ignore-"));
  const source = await mkdtemp(join(dir, "src-"));
  try {
    await writeFile(config, GITLEAKS_CONFIG);
    const { code, stderr } = await run(
      binary,
      [
        "git",
        source,
        "--config",
        config,
        "--gitleaks-ignore-path",
        ignoreDir,
        "--ignore-gitleaks-allow",
        "--log-opts",
        revs.join(" "),
        "--no-banner",
        "--redact",
        "--report-format",
        "json",
        "--report-path",
        report,
        "--exit-code",
        "0",
      ],
      safeGitEnv({ GIT_DIR: gitDir }),
    );
    if (code !== 0) throw new Error(`gitleaks failed (${code}): ${stderr.trim().slice(-300)}`);
    const parsed: unknown = JSON.parse(await readFile(report, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((f: { RuleID?: string; File?: string; Commit?: string }) => ({
      source: "gitleaks" as const,
      rule: f.RuleID ?? "unknown",
      location: f.File ?? "unknown",
      ...(f.Commit ? { commit: f.Commit } : {}),
    }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Scans every blob reachable from any ref for known secret values. */
async function scanValues(
  gitDir: string,
  revs: string[],
  secrets: Array<{ name: string; value: string }>,
  maxBlobBytes: number,
): Promise<{ findings: SecretFinding[]; blobs: number }> {
  const needles = secrets.flatMap((s) =>
    secretNeedles(s.value).map((n) => ({ name: s.name, needle: n })),
  );
  const git = (args: string[], input?: string) =>
    run("git", [...gitLocation(gitDir), ...args], safeGitEnv(), input);
  const objects = await git(["rev-list", "--objects", ...revs, "--"]);
  if (objects.code !== 0) throw new Error(`git rev-list failed: ${objects.stderr.trim()}`);
  const ids = objects.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const space = l.indexOf(" ");
      return space === -1
        ? { id: l, path: "" }
        : { id: l.slice(0, space), path: l.slice(space + 1) };
    });
  if (ids.length === 0) return { findings: [], blobs: 0 };
  const check = await git(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    `${ids.map((i) => i.id).join("\n")}\n`,
  );
  const pathById = new Map(ids.map((i) => [i.id, i.path]));
  const blobs: Array<{ id: string; size: number }> = [];
  for (const line of check.stdout.toString().split("\n")) {
    const [id, type, size] = line.split(" ");
    if (id && type === "blob") blobs.push({ id, size: Number(size) });
  }
  const findings: SecretFinding[] = [];
  const scanned = blobs.filter((b) => {
    if (b.size > maxBlobBytes) {
      findings.push({
        source: "value",
        rule: "blob-too-large",
        location: pathById.get(b.id) || b.id,
      });
      return false;
    }
    return true;
  });
  if (scanned.length === 0 || needles.length === 0) return { findings, blobs: scanned.length };
  const batch = await git(["cat-file", "--batch"], `${scanned.map((b) => b.id).join("\n")}\n`);
  const data = batch.stdout;
  let offset = 0;
  for (const blob of scanned) {
    const headerEnd = data.indexOf(10, offset);
    const start = headerEnd + 1;
    const content = data.subarray(start, start + blob.size);
    offset = start + blob.size + 1;
    for (const { name, needle } of needles) {
      if (content.includes(needle)) {
        findings.push({
          source: "value",
          rule: `value:${name}`,
          location: pathById.get(blob.id) || blob.id,
        });
        break;
      }
    }
  }
  return { findings, blobs: scanned.length };
}

/** Gate run before any push or visibility change. Reports locations and rule names only. */
export async function runSecretGate(options: SecretGateOptions): Promise<SecretGateResult> {
  const findings: SecretFinding[] = [];
  const revs = options.revs ?? ["--all"];
  if (!options.skipGitleaks)
    findings.push(
      ...(await scanGitleaks(options.gitDir, revs, options.gitleaksBinary ?? "gitleaks")),
    );
  const values = await scanValues(
    options.gitDir,
    revs,
    options.secretValues ?? [],
    options.maxBlobBytes ?? 20 * 1024 * 1024,
  );
  findings.push(...values.findings);
  const ok = findings.length === 0;
  return {
    ok,
    findings,
    blobsScanned: values.blobs,
    receipt: {
      kind: "secret-scan",
      ok,
      summary: ok
        ? `secret gate clean (${values.blobs} blobs${options.skipGitleaks ? "" : " + gitleaks"})`
        : `secret gate blocked: ${findings.map((f) => `${f.rule} @ ${f.location}`).join(", ")}`,
      data: { findings, blobsScanned: values.blobs },
    },
  };
}
