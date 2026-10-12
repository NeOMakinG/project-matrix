import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import { sandboxTool } from "./toolchain";

export interface SqlcFinding {
  file: string;
  message: string;
}

const SQLC_CONFIG = /(^|\/)sqlc\.(yaml|yml|json)$/;

interface SqlcConfig {
  plugins?: unknown;
  cloud?: unknown;
  sql?: {
    schema?: string | string[];
    queries?: string | string[];
    gen?: { go?: { out?: string } };
    codegen?: unknown;
    database?: unknown;
  }[];
}

/**
 * Verifies that every file in each sqlc output package is exactly what `sqlc generate` produces
 * from the committed SQL. Hand-written or edited files in a generated package, configs that run
 * plugins or need a database, and a missing sqlc binary are all violations (fail closed).
 */
export async function verifySqlc(root: string, allFiles: string[]): Promise<SqlcFinding[]> {
  const findings: SqlcFinding[] = [];
  const claimed = new Set<string>();
  for (const config of allFiles.filter((f) => SQLC_CONFIG.test(f))) {
    const configDir = posix.dirname(config) === "." ? "" : posix.dirname(config);
    let doc: SqlcConfig;
    try {
      doc = parseYaml(await readFile(join(root, config), "utf8")) as SqlcConfig;
    } catch (e) {
      findings.push({ file: config, message: `sqlc config cannot be parsed (${String(e)})` });
      continue;
    }
    if (!Array.isArray(doc?.sql)) {
      findings.push({
        file: config,
        message: "sqlc config has no supported sql array: unverifiable",
      });
      continue;
    }
    if (doc.sql.some((entry) => !entry || typeof entry !== "object")) {
      findings.push({ file: config, message: "invalid sqlc sql entry: unverifiable" });
      continue;
    }
    if (doc?.plugins || doc?.cloud || doc.sql.some((s) => s.codegen || s.database)) {
      findings.push({
        file: config,
        message:
          "sqlc config uses plugins, cloud or a live database; generated code cannot be verified",
      });
      continue;
    }
    const references = doc.sql.flatMap((entry) => [entry.schema, entry.queries].flat());
    if (
      references.some((reference) => {
        if (typeof reference !== "string") return true;
        const path = posix.normalize(posix.join(configDir, reference));
        return posix.isAbsolute(reference) || path === ".." || path.startsWith("../");
      })
    ) {
      findings.push({
        file: config,
        message: "sqlc input reference outside isolated repository or unsupported: unverifiable",
      });
      continue;
    }
    const rawOuts = doc.sql
      .map((s) => s.gen?.go?.out)
      .filter((out): out is string => typeof out === "string");
    const outs = rawOuts.map((out) => posix.normalize(posix.join(configDir, out)));
    if (
      !outs.length ||
      rawOuts.some((out) => posix.isAbsolute(out)) ||
      outs.some((out) => out.startsWith("../") || posix.isAbsolute(out) || out === ".")
    ) {
      findings.push({
        file: config,
        message: "sqlc output path unsupported or outside repository: unverifiable",
      });
      continue;
    }
    // Go files in an output package must be sqlc output; SQL inputs may live alongside them.
    const generatedFiles = (out: string) =>
      allFiles.filter((f) => f.startsWith(`${out}/`) && f.endsWith(".go"));
    const committed = outs.flatMap(generatedFiles);
    for (const file of committed) claimed.add(file);
    const tmp = await mkdtemp(join(tmpdir(), "matrix-sqlc-"));
    try {
      const inputs = allFiles.filter((f) => f.endsWith(".sql") || f === config);
      for (const f of inputs) {
        await mkdir(join(tmp, dirname(f)), { recursive: true });
        await cp(join(root, f), join(tmp, f), { dereference: true });
      }
      const res = sandboxTool("sqlc", ["generate", "-f", config], tmp, tmp);
      if (res.error || res.status !== 0) {
        const why = res.error
          ? `sqlc sandbox/toolchain unavailable: ${res.error.message}`
          : `sqlc sandbox/generate failed: ${res.stderr.trim().slice(0, 200)}`;
        for (const f of committed.length ? committed : [config])
          findings.push({ file: f, message: `generated package cannot be verified: ${why}` });
        continue;
      }
      for (const f of committed) {
        const want = await readFile(join(tmp, f)).catch(() => undefined);
        if (want === undefined)
          findings.push({
            file: f,
            message: "not produced by sqlc generate: hand-written file in a generated package",
          });
        else if (!want.equals(await readFile(join(root, f))))
          findings.push({
            file: f,
            message: "differs from sqlc generate output: generated code was edited or is stale",
          });
      }
      for (const out of outs) {
        const expected = await readdir(join(tmp, out), { recursive: true }).catch(() => []);
        for (const file of expected.filter((file) => file.endsWith(".go"))) {
          const path = posix.join(out, file);
          if (!committed.includes(path))
            findings.push({ file: path, message: "missing sqlc generated output" });
        }
      }
    } catch (error) {
      findings.push({ file: config, message: `sqlc output unverifiable: ${String(error)}` });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  for (const file of allFiles.filter((file) => /(^|\/)internal\/db\/.*\.go$/.test(file))) {
    if (!claimed.has(file))
      findings.push({ file, message: "internal/db has no verifiable sqlc output configuration" });
  }
  return findings;
}
