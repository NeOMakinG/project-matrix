import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { sandboxTool } from "./toolchain";

/** One Go package as reported by `go list -e -json`. */
export interface GoPackage {
  /** Package directory, repo-relative POSIX path. */
  dir: string;
  /** Repo-relative paths of every Go file in the package (incl. tests and build-tag-ignored). */
  files: string[];
  /** Files excluded by build constraints: their imports are not in `imports`. */
  ignoredFiles: string[];
  /** Imports, test imports and external-test imports, as normalised by the toolchain. */
  imports: string[];
  error?: string;
}

export type GoListResult = { ok: true; packages: GoPackage[] } | { ok: false; error: string };

/** Toolchain environment: no network, no toolchain download, no workspace mixing. */
const GO_ENV = {
  GOTOOLCHAIN: "local",
  GOPROXY: "off",
  GOFLAGS: "-mod=readonly",
  GOWORK: "off",
  CGO_ENABLED: "0",
};

const toPosix = (p: string) => p.split("\\").join("/");

/** Parses the concatenated JSON objects `go list -json` prints. */
export function parseGoListJson(out: string): Record<string, unknown>[] {
  const objs: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) objs.push(JSON.parse(out.slice(start, i + 1)));
    }
  }
  return objs;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Lists every package of the Go module rooted at `moduleDir` (absolute) via the Go toolchain. */
export function goList(root: string, moduleDir: string): GoListResult {
  const scratch = mkdtempSync(join(tmpdir(), "matrix-golist-"));
  let res;
  try {
    res = sandboxTool("go", ["list", "-e", "-json", "./..."], moduleDir, scratch, {
      ...GO_ENV,
      GOCACHE: join(scratch, "cache"),
      GOPATH: join(scratch, "gopath"),
    });
  } catch (error) {
    return { ok: false, error: String(error) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (res.error) return { ok: false, error: `go toolchain unavailable (${res.error.message})` };
  if (res.status !== 0)
    return { ok: false, error: `go list failed: ${res.stderr.trim().slice(0, 300)}` };
  const packages: GoPackage[] = [];
  // `go list` reports real paths (e.g. /private/tmp on macOS); compare against the real root.
  const realRoot = realpathSync(root);
  for (const p of parseGoListJson(res.stdout)) {
    const dir = typeof p.Dir === "string" ? p.Dir : "";
    const rel = toPosix(relative(realRoot, dir));
    if (!dir || rel.startsWith("..")) continue;
    const at = (f: string) => (rel ? `${rel}/${f}` : f);
    const own = ["GoFiles", "CgoFiles", "TestGoFiles", "XTestGoFiles"].flatMap((k) =>
      strings(p[k]),
    );
    const ignored = strings(p.IgnoredGoFiles);
    const err = (p.Error as { Err?: string } | undefined)?.Err;
    packages.push({
      dir: rel,
      files: [...own, ...ignored].map(at),
      ignoredFiles: ignored.map(at),
      imports: [
        ...new Set(["Imports", "TestImports", "XTestImports"].flatMap((k) => strings(p[k]))),
      ],
      ...(err ? { error: err } : {}),
    });
  }
  return { ok: true, packages };
}

/** Go module roots (dirs with go.mod) plus `use` targets of every go.work that escape the repo. */
export function goModules(allFiles: string[], root: string): { modules: string[] } {
  const modules = allFiles
    .filter((f) => f === "go.mod" || f.endsWith("/go.mod"))
    .map((f) => toPosix(dirname(f)))
    .map((d) => (d === "." ? "" : d));
  return { modules: [...new Set(modules)].sort() };
}

/** `use` directives of a go.work file, resolved relative to it; entries outside root are returned. */
export function goWorkEscapes(workFile: string, text: string, root: string): string[] {
  const uses: string[] = [];
  const block = /\buse\s*\(([^)]*)\)/g;
  for (let m = block.exec(text); m; m = block.exec(text))
    uses.push(
      ...(m[1] ?? "")
        .split("\n")
        .map((l) => l.replace(/\/\/.*$/, "").trim())
        .filter(Boolean),
    );
  for (const m of text.matchAll(/^\s*use\s+([^\s(][^\s]*)/gm)) uses.push(m[1] ?? "");
  const base = resolve(root, dirname(workFile));
  return uses
    .map((u) => u.replace(/^"|"$/g, ""))
    .filter((u) => toPosix(relative(root, resolve(base, u))).startsWith(".."));
}

export function goWorkReferences(text: string): string[] {
  const scratch = mkdtempSync(join(tmpdir(), "matrix-gowork-"));
  try {
    writeFileSync(join(scratch, "go.work"), text);
    const result = sandboxTool(
      "go",
      ["work", "edit", "-json", "go.work"],
      scratch,
      scratch,
      GO_ENV,
    );
    if (result.error || result.status !== 0)
      throw new Error(result.error?.message ?? result.stderr);
    const doc = JSON.parse(result.stdout) as { Use?: { DiskPath: string }[] };
    return (doc.Use ?? []).map((use) => use.DiskPath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export const absolute = (root: string, rel: string) => (rel ? join(root, rel) : root);

/** Go helper: exact per-file imports from go/parser (ignores build tags, decodes all escapes). */
const HELPER_SRC = `package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
)

type imp struct {
	Path string \`json:"path"\`
	Line int    \`json:"line"\`
}

type dbCall struct {
	Method string \`json:"method"\`
	Line int \`json:"line"\`
}

type res struct {
	Imports []imp  \`json:"imports"\`
	DBCalls []dbCall \`json:"dbCalls"\`
	Error   string \`json:"error,omitempty"\`
}

func main() {
	fset := token.NewFileSet()
	out := map[string]res{}
	for _, f := range os.Args[1:] {
		af, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			out[f] = res{Error: err.Error()}
			continue
		}
		r := res{Imports: []imp{}, DBCalls: []dbCall{}}
		for _, s := range af.Imports {
			p, err := strconv.Unquote(s.Path.Value)
			if err != nil {
				r.Error = "bad import literal " + s.Path.Value
				continue
			}
			r.Imports = append(r.Imports, imp{p, fset.Position(s.Pos()).Line})
		}
		ast.Inspect(af, func(node ast.Node) bool {
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch selector.Sel.Name {
			case "Query", "QueryRow", "Exec", "QueryContext", "QueryRowContext", "ExecContext":
				r.DBCalls = append(r.DBCalls, dbCall{selector.Sel.Name, fset.Position(selector.Sel.Pos()).Line})
			}
			return true
		})
		out[f] = r
	}
	_ = json.NewEncoder(os.Stdout).Encode(out)
}
`;

export interface FileImports {
  imports: { path: string; line: number }[];
  dbCalls?: { method: string; line: number }[];
  error?: string;
}

let helperBinary: string | undefined;

/** Builds the go/parser helper once per process (stdlib only, offline). */
function helper(): string {
  if (helperBinary) return helperBinary;
  const dir = mkdtempSync(join(tmpdir(), "matrix-goparse-"));
  writeFileSync(join(dir, "go.mod"), "module matrixgoparse\n\ngo 1.21\n");
  writeFileSync(join(dir, "main.go"), HELPER_SRC);
  const res = spawnSync("go", ["build", "-o", "goparse", "."], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, GOCACHE: join(dir, "cache"), ...GO_ENV, GOFLAGS: "" },
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `cannot build go/parser helper: ${res.error?.message ?? res.stderr.trim().slice(0, 200)}`,
    );
  }
  helperBinary = join(dir, "goparse");
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return helperBinary;
}

/** Per-file imports for absolute Go file paths, parsed by Go's own parser. */
export function goParseImports(files: string[]): Map<string, FileImports> {
  const out = new Map<string, FileImports>();
  const bin = helper();
  for (let i = 0; i < files.length; i += 200) {
    const chunk = files.slice(i, i + 200);
    const scratch = mkdtempSync(join(tmpdir(), "matrix-goparse-run-"));
    let res;
    try {
      res = sandboxTool(bin, chunk, scratch, scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (res.error || res.status !== 0)
      throw new Error(`go/parser helper failed: ${res.stderr ?? res.error}`);
    const parsed = JSON.parse(res.stdout) as Record<string, FileImports>;
    for (const f of chunk) out.set(f, parsed[f] ?? { imports: [], error: "not parsed" });
  }
  return out;
}
