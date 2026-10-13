import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Receipt } from "@matrix/core";

const exec = promisify(execFile);

export async function scanCommittedHistory(
  repo: string,
  range: string,
  binary = "gitleaks",
): Promise<Receipt> {
  const directory = await mkdtemp(join(tmpdir(), "matrix-history-scan-"));
  try {
    const marker = join(repo, ".git");
    if (!(await lstat(marker)).isDirectory()) throw new Error("canonical git directory required");
    const gitDir = await realpath(marker);
    if (/[\r\n]/.test(gitDir)) throw new Error("invalid git path");
    const source = join(directory, "source");
    await mkdir(source, { mode: 0o700 });
    await writeFile(join(source, ".git"), `gitdir: ${gitDir}\n`, { mode: 0o600 });
    const config = join(directory, "gitleaks.toml");
    const report = join(directory, "report.json");
    const ignore = join(directory, "ignore");
    await writeFile(config, "[extend]\nuseDefault = true\n", { mode: 0o600 });
    await writeFile(ignore, "", { mode: 0o600 });
    let failed = false;
    try {
      const result = await exec(
        binary,
        [
          "git",
          source,
          "--config",
          config,
          "--gitleaks-ignore-path",
          ignore,
          "--ignore-gitleaks-allow",
          "--log-opts",
          `--no-ext-diff --no-textconv ${range}`,
          "--no-banner",
          "--redact",
          "--report-format",
          "json",
          "--report-path",
          report,
        ],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: directory,
            TMPDIR: tmpdir(),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
          timeout: 60_000,
        },
      );
      failed = /\b(?:ERR|FTL)\b|stderr is not empty/.test(result.stderr);
    } catch {
      failed = true;
    }
    const findings: unknown = JSON.parse(await readFile(report, "utf8"));
    if (!Array.isArray(findings)) throw new Error("invalid gitleaks report");
    const ok = !failed && findings.length === 0;
    return {
      kind: "secret-scan",
      ok,
      summary: ok
        ? "committed history secret scan passed"
        : "committed history secret scan blocked",
      data: {
        range,
        findings: findings.map((finding: { RuleID?: string; File?: string }) => ({
          rule: finding.RuleID ?? "unknown",
          file: finding.File ?? "unknown",
        })),
      },
    };
  } catch {
    return {
      kind: "secret-scan",
      ok: false,
      summary: "committed history secret scan unavailable or invalid; refusing to proceed",
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
