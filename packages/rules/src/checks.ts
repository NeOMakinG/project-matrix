import {
  extractImports,
  type ImportRef,
  inScope,
  lineIndex,
  parseSource,
  type Resolver,
  type Scope,
} from "@matrix/graph";
import picomatch from "picomatch";
import ts from "typescript";
import { callPatternHits } from "./callpattern";
import { goDatabaseCallHits, goImportHits } from "./goimports";
import type { FileImports, GoListResult } from "./golist";
import { compileSafeRegex, MAX_REGEX_SCAN_BYTES } from "./safe";
import type { RuleCheck } from "./schema";
import { verifySqlc } from "./sqlc";
import { verifyTauriCapabilities } from "./tauri";

export interface Hit {
  file: string;
  line: number;
  message: string;
  /** Downgrades the rule's severity for hits the engine cannot judge (e.g. computed imports). */
  severity?: "warning";
}

/** Lazily reads and caches file text, parsed imports, source trees and a type-checked program. */
export interface SourceIndex {
  files: string[];
  /** Non-JS text files (Go, Rust, JSON, YAML…) scanned only by text rules. */
  textFiles: string[];
  /** Every file in the project listing (any type). */
  allFiles: string[];
  /** Absolute project root on disk (empty for in-memory harness runs). */
  root: string;
  known: ReadonlySet<string>;
  text(file: string): Promise<string>;
  imports(file: string): Promise<ImportRef[]>;
  sourceFile(file: string): Promise<ts.SourceFile>;
  /** Resolves a specifier (relative, workspace package, tsconfig paths) to a repo file. */
  resolve(from: string, specifier: string): string | undefined;
  /** Type-checked program over the given files, for symbol-based matching. */
  program(files: string[]): Promise<ts.Program>;
  /** Absolute path of a repo file, as the program sees it. */
  absolute(file: string): string;
}

export { parseCallPattern } from "./callpattern";

const filesInScope = (index: SourceIndex, check: Scope) =>
  index.files.filter((f) => inScope(f, check));

/** Text rules see JS/TS sources plus other text files. */
const textFilesInScope = (index: SourceIndex, check: Scope) =>
  [...index.files, ...index.textFiles].filter((f) => inScope(f, check));

const computedHit = (file: string, ref: ImportRef): Hit => ({
  file,
  line: ref.line,
  message: `computed ${ref.kind === "require" ? "require()" : "import()"} cannot be checked statically`,
  severity: "warning",
});

/** One `go list` per module per source index (one `matrix check` run). */
const goListCaches = new WeakMap<SourceIndex, Map<string, GoListResult>>();
const goParseCaches = new WeakMap<SourceIndex, Map<string, FileImports>>();

/** Reads a file for structural checks, refusing anything above the scan cap. */
const cappedText = (index: SourceIndex) => async (file: string) => {
  const text = await index.text(file);
  if (text.length > MAX_REGEX_SCAN_BYTES) throw new Error(`${file} is too large to verify`);
  return text;
};

/** Runs one rule body against the indexed sources. */
export async function runCheck(check: RuleCheck, index: SourceIndex): Promise<Hit[]> {
  const hits: Hit[] = [];
  switch (check.type) {
    case "forbidden-import": {
      const re = compileSafeRegex(check.import);
      for (const file of filesInScope(index, check))
        for (const ref of await index.imports(file)) {
          if (ref.kind === "type" && !check.includeTypeImports) continue;
          if (ref.computed) hits.push(computedHit(file, ref));
          else if (re.test(ref.specifier))
            hits.push({ file, line: ref.line, message: `imports "${ref.specifier}"` });
        }
      break;
    }
    case "boundary": {
      const disallowed = picomatch(check.disallow, { dot: true });
      const allowed = check.allow ? picomatch(check.allow, { dot: true }) : () => false;
      for (const file of filesInScope(index, check))
        for (const ref of await index.imports(file)) {
          if (ref.kind === "type" && !check.includeTypeImports) continue;
          if (ref.computed) {
            hits.push(computedHit(file, ref));
            continue;
          }
          const target = index.resolve(file, ref.specifier);
          if (target && disallowed(target) && !allowed(target))
            hits.push({
              file,
              line: ref.line,
              message: `imports ${target}${target === ref.specifier ? "" : ` (via "${ref.specifier}")`} across a boundary`,
            });
        }
      break;
    }
    case "call-pattern":
      hits.push(...(await callPatternHits(check, index)));
      break;
    case "regex": {
      const re = compileSafeRegex(check.pattern, `${(check.flags ?? "").replace("g", "")}g`);
      for (const file of textFilesInScope(index, check)) {
        const text = await index.text(file);
        if (text.length > MAX_REGEX_SCAN_BYTES) {
          hits.push({ file, line: 1, message: "file too large for regex rules; not scanned" });
          continue;
        }
        const lineOf = lineIndex(text);
        for (const m of text.matchAll(re))
          hits.push({ file, line: lineOf(m.index ?? 0), message: `matches /${check.pattern}/` });
      }
      break;
    }
    case "go-imports":
    case "go-db-calls": {
      const cached = goListCaches.get(index) ?? new Map();
      goListCaches.set(index, cached);
      const parsed = goParseCaches.get(index) ?? new Map();
      goParseCaches.set(index, parsed);
      const ctx = {
        root: index.root,
        allFiles: index.allFiles,
        text: cappedText(index),
        cache: cached,
        parseCache: parsed,
      };
      if (check.type === "go-imports") {
        hits.push(...(await goImportHits(ctx, check, compileSafeRegex(check.import, ""))));
      } else {
        hits.push(...(await goDatabaseCallHits(ctx, check)));
      }
      break;
    }
    case "tauri-capabilities": {
      for (const f of await verifyTauriCapabilities(index.allFiles, cappedText(index), check.allow))
        hits.push({ file: f.file, line: 1, message: f.message });
      break;
    }
    case "sqlc-generated": {
      if (!index.root) {
        hits.push({
          file: "sqlc.yaml",
          line: 1,
          message: "sqlc output unverifiable: no disk root",
        });
        break;
      }
      for (const f of await verifySqlc(index.root, index.allFiles))
        hits.push({ file: f.file, line: 1, message: f.message });
      break;
    }
    case "required-header": {
      const re = compileSafeRegex(check.header, "m");
      for (const file of textFilesInScope(index, check)) {
        const head = (await index.text(file)).split("\n").slice(0, 10).join("\n");
        if (!re.test(head)) hits.push({ file, line: 1, message: "missing required header" });
      }
      break;
    }
  }
  return hits;
}

export interface SourceIndexOptions {
  /** Absolute project root; a virtual root is used for in-memory sources. */
  root: string;
  resolver: Resolver;
  /** Non-JS text files for regex and header rules. */
  textFiles?: string[];
  allFiles?: string[];
  /** Set when files live on disk, so toolchain-backed checks can run. */
  diskRoot?: string;
}

const PROGRAM_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
  types: [],
  noEmit: true,
  skipLibCheck: true,
};

export function createSourceIndex(
  files: string[],
  read: (file: string) => Promise<string>,
  opts: SourceIndexOptions,
): SourceIndex {
  const texts = new Map<string, Promise<string>>();
  const imports = new Map<string, Promise<ImportRef[]>>();
  const trees = new Map<string, Promise<ts.SourceFile>>();
  const programs = new Map<string, Promise<ts.Program>>();
  const absolute = (file: string) => `${opts.root.replace(/\/+$/, "")}/${file}`;
  const text = (file: string) => {
    let p = texts.get(file);
    if (!p) {
      p = read(file);
      texts.set(file, p);
    }
    return p;
  };

  const buildProgram = async (scope: string[]) => {
    const loaded = new Map<string, string>();
    for (const f of files) loaded.set(absolute(f), await text(f));
    const host = ts.createCompilerHost(PROGRAM_OPTIONS, true);
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const readFile = host.readFile.bind(host);
    host.fileExists = (f) => loaded.has(f) || fileExists(f);
    host.readFile = (f) => loaded.get(f) ?? readFile(f);
    host.getSourceFile = (f, lang, onError, create) => {
      const t = loaded.get(f);
      return t !== undefined
        ? ts.createSourceFile(f, t, lang, true)
        : getSourceFile(f, lang, onError, create);
    };
    return ts.createProgram(scope.map(absolute), PROGRAM_OPTIONS, host);
  };

  return {
    files,
    textFiles: opts.textFiles ?? [],
    allFiles: opts.allFiles ?? [...files, ...(opts.textFiles ?? [])],
    root: opts.diskRoot ?? "",
    known: new Set(files),
    text,
    absolute,
    resolve: (from, specifier) => opts.resolver.resolve(from, specifier),
    imports(file) {
      let p = imports.get(file);
      if (!p) {
        p = text(file).then((t) => extractImports(file, t));
        imports.set(file, p);
      }
      return p;
    },
    sourceFile(file) {
      let p = trees.get(file);
      if (!p) {
        p = text(file).then((t) => parseSource(file, t));
        trees.set(file, p);
      }
      return p;
    },
    program(scope) {
      const key = [...scope].sort().join("\0");
      let p = programs.get(key);
      if (!p) {
        p = buildProgram(scope);
        programs.set(key, p);
      }
      return p;
    },
  };
}
