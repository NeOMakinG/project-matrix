import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { Receipt } from "@matrix/core";
import { GITLEAKS_CONFIG, safeGitEnv, secretNeedles } from "@matrix/sandbox";

const exec = promisify(execFile);

export async function scanSourceSnapshot(
  source: string,
  secretValues: string[],
  binary = "gitleaks",
  binding?: { tree: string; objects: Array<{ path: string; sha: string }> },
): Promise<Receipt> {
  const directory = await mkdtemp(join(tmpdir(), "matrix-source-scan-"));
  try {
    if (secretValues.some((value) => value.length < 8))
      throw new Error("invalid secret scan credential");
    const needles = secretValues.flatMap(secretNeedles);
    const objects = new Map(binding?.objects.map((object) => [object.path, object.sha]));
    if (
      binding &&
      (!/^[0-9a-f]{40,64}$/.test(binding.tree) || objects.size !== binding.objects.length)
    )
      throw new Error("invalid candidate binding");
    const pending = [source];
    let bytes = 0;
    let entries = 0;
    while (pending.length) {
      const parent = pending.pop() as string;
      for (const entry of await readdir(parent)) {
        if (++entries > 100_000) throw new Error("snapshot scan entry limit");
        const path = join(parent, entry);
        const stat = await lstat(path);
        if (stat.isDirectory()) pending.push(path);
        else if (stat.isFile()) {
          bytes += stat.size;
          if (stat.size > 16 * 1024 ** 2 || bytes > 128 * 1024 ** 2)
            throw new Error("snapshot scan byte limit");
          const content = await readFile(path);
          if (binding) {
            const name = relative(source, path);
            const sha = objects.get(name);
            if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("unbound candidate file");
            const actual = createHash(sha.length === 40 ? "sha1" : "sha256")
              .update(`blob ${content.length}\0`)
              .update(content)
              .digest("hex");
            if (actual !== sha) throw new Error("candidate blob mismatch");
            objects.delete(name);
          }
          if (needles.some((needle) => content.includes(needle)))
            throw new Error("known credential in snapshot");
        } else throw new Error("non-regular snapshot entry");
      }
    }
    if (objects.size) throw new Error("candidate blobs missing");
    const config = join(directory, "gitleaks.toml");
    const ignore = join(directory, "ignore");
    const report = join(directory, "report.json");
    await writeFile(config, GITLEAKS_CONFIG, { mode: 0o600 });
    await writeFile(ignore, "", { mode: 0o600 });
    const result = await exec(
      binary,
      [
        "dir",
        source,
        "--config",
        config,
        "--gitleaks-ignore-path",
        ignore,
        "--ignore-gitleaks-allow",
        "--no-banner",
        "--redact",
        "--report-format",
        "json",
        "--report-path",
        report,
      ],
      {
        cwd: directory,
        env: safeGitEnv({ HOME: directory }),
        timeout: 60_000,
      },
    );
    if (/\b(?:ERR|FTL)\b/.test(result.stderr)) throw new Error("scanner error");
    const findings: unknown = JSON.parse(await readFile(report, "utf8"));
    if (!Array.isArray(findings) || findings.length)
      throw new Error("snapshot scan findings or invalid report");
    return {
      kind: "secret-scan",
      ok: true,
      summary: "host-owned source snapshot secret scan passed",
      data: {
        entries,
        bytes,
        ...(binding ? { tree: binding.tree, objects: binding.objects } : {}),
      },
    };
  } catch {
    return {
      kind: "secret-scan",
      ok: false,
      summary: "source snapshot secret scan failed or unavailable; handover refused",
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
