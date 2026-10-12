import { posix } from "node:path";
import type { Scope } from "@matrix/graph";
import { inScope } from "@matrix/graph";
import {
  absolute,
  type FileImports,
  type GoListResult,
  goList,
  goModules,
  goParseImports,
  goWorkReferences,
} from "./golist";
import { parseGoImports } from "./structural";

export interface GoImportHit {
  file: string;
  line: number;
  message: string;
  severity?: "warning";
}

export interface GoImportContext {
  root: string;
  allFiles: string[];
  text(file: string): Promise<string>;
  /** Per-run cache so every module is listed once. */
  cache: Map<string, GoListResult>;
  parseCache?: Map<string, FileImports>;
}

/**
 * Forbidden Go imports, using the Go toolchain (`go list`) as the source of truth for what each
 * package imports, across every module in the repo. Without a disk root (in-memory harness) the
 * text parser runs as a fallback and every hit is downgraded to a warning; without the toolchain
 * the rule fails as unverifiable.
 */
export async function goImportHits(
  ctx: GoImportContext,
  check: Scope & { import: string },
  re: RegExp,
): Promise<GoImportHit[]> {
  const hits: GoImportHit[] = [];
  const goFiles = ctx.allFiles.filter((f) => f.endsWith(".go"));

  if (!ctx.root) {
    hits.push({
      file: scopedFile(goFiles, check),
      line: 1,
      message: "Go imports unverifiable: no disk root/toolchain verification",
    });
    for (const file of goFiles.filter((f) => inScope(f, check)))
      for (const imp of parseGoImports(await ctx.text(file)))
        if (re.test(imp.path))
          hits.push({
            file,
            line: imp.line,
            message: `imports "${imp.path}" (text fallback, unverified)`,
            severity: "warning",
          });
    return hits;
  }

  for (const work of ctx.allFiles.filter(
    (file) => file === "go.work" || file.endsWith("/go.work"),
  )) {
    try {
      for (const reference of goWorkReferences(await ctx.text(work))) {
        const target = posix.normalize(posix.join(posix.dirname(work), reference));
        if (
          posix.isAbsolute(reference) ||
          target === ".." ||
          target.startsWith("../") ||
          !ctx.allFiles.includes(posix.join(target, "go.mod"))
        ) {
          hits.push({
            file: work,
            line: 1,
            message: `go.work uses "${reference}" outside the repository or missing module: unverifiable`,
          });
        }
      }
    } catch (error) {
      hits.push({ file: work, line: 1, message: `go.work unverifiable: ${String(error)}` });
    }
  }

  const { modules } = goModules(ctx.allFiles, ctx.root);
  const covered = new Set<string>();
  for (const mod of modules) {
    if (!goFiles.some((file) => (mod === "" || file.startsWith(`${mod}/`)) && inScope(file, check)))
      continue;
    const key = mod || ".";
    let listed = ctx.cache.get(key);
    if (!listed) {
      listed = goList(ctx.root, absolute(ctx.root, mod));
      ctx.cache.set(key, listed);
    }
    if (!listed.ok) {
      hits.push({
        file: mod ? `${mod}/go.mod` : "go.mod",
        line: 1,
        message: `Go imports unverifiable: ${listed.error}`,
      });
      continue;
    }
    for (const pkg of listed.packages) {
      for (const f of pkg.files) covered.add(f);
      if (pkg.error && pkg.imports.length === 0 && pkg.files.some((f) => inScope(f, check)))
        hits.push({
          file: pkg.files.find((f) => inScope(f, check)) ?? pkg.dir,
          line: 1,
          message: `go list cannot parse package: ${pkg.error}`,
        });
    }
  }

  // Per-file imports from go/parser (exact: aliases, escapes, comments, build-tag-excluded files).
  const scoped = goFiles.filter((f) => inScope(f, check));
  if (!scoped.length) return hits;
  if (hits.some((hit) => hit.message.includes("unverifiable"))) {
    for (const file of scoped)
      hits.push({
        file,
        line: 1,
        message: "Go imports unverifiable: module/workspace toolchain verification failed",
      });
    return hits;
  }
  const parsed = ctx.parseCache ?? new Map<string, FileImports>();
  const missing = scoped
    .map((file) => absolute(ctx.root, file))
    .filter((file) => !parsed.has(file));
  try {
    if (missing.length) {
      for (const [file, imports] of goParseImports(missing)) parsed.set(file, imports);
    }
  } catch (e) {
    for (const file of missing)
      parsed.set(file, { imports: [], error: `Go imports unverifiable: ${String(e)}` });
  }
  for (const f of scoped) {
    const r = parsed.get(absolute(ctx.root, f));
    if (!r || r.error) {
      hits.push({
        file: f,
        line: 1,
        message: `Go file cannot be parsed: ${r?.error ?? "missing"}`,
      });
      continue;
    }
    for (const imp of r.imports)
      if (re.test(imp.path))
        hits.push({ file: f, line: imp.line, message: `imports "${imp.path}"` });
  }
  // Go files no module claims (outside any go.mod) cannot be listed: refuse them.
  for (const f of goFiles)
    if (!covered.has(f) && inScope(f, check))
      hits.push({
        file: f,
        line: 1,
        message: "Go file outside any listed module/package: imports unverifiable",
      });
  return hits;
}

function scopedFile(files: string[], scope: Scope): string {
  return files.find((file) => inScope(file, scope)) ?? "go.mod";
}

export async function goDatabaseCallHits(
  ctx: GoImportContext,
  scope: Scope,
): Promise<GoImportHit[]> {
  const verified = { ...ctx, parseCache: ctx.parseCache ?? new Map<string, FileImports>() };
  const errors = await goImportHits(verified, { ...scope, import: "(?!)" }, new RegExp("(?!)"));
  if (errors.length) return errors;
  const hits: GoImportHit[] = [];
  for (const file of ctx.allFiles.filter((file) => file.endsWith(".go") && inScope(file, scope))) {
    const parsed = verified.parseCache.get(absolute(ctx.root, file));
    if (!parsed?.dbCalls) {
      hits.push({ file, line: 1, message: "Go database calls unverifiable: missing AST results" });
      continue;
    }
    for (const call of parsed.dbCalls) {
      hits.push({
        file,
        line: call.line,
        message: `raw database method reference ${call.method} is allowed only in verified sqlc output`,
      });
    }
  }
  return hits;
}
