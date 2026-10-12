import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import ts from "typescript";
import { listSourceFiles } from "./files";
import {
  extractImports,
  type ImportKind,
  isRelative,
  packageOf,
  parseSource,
  resolveRelative,
} from "./imports";

export const CODE_GRAPH_VERSION = 1;

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "namespace";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
}

export interface ModuleImport {
  specifier: string;
  line: number;
  kind: ImportKind;
  /** Repo-relative path for imports that resolve to a file in the repo. */
  target?: string;
  /** Package name for bare specifiers. */
  package?: string;
}

export interface CodeModule {
  path: string;
  imports: ModuleImport[];
  exports: string[];
  symbols: CodeSymbol[];
}

export interface CodeGraph {
  version: number;
  modules: CodeModule[];
  /** External packages and how many modules import each. */
  packages: { name: string; importers: number }[];
  /** Import cycles between repo files (runtime imports only), each sorted. */
  cycles: string[][];
}

const hasExport = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const hasDefault = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

/** Top-level declarations and the names a module exports. */
export function extractSymbols(path: string, text: string) {
  const sf = parseSource(path, text);
  const symbols: CodeSymbol[] = [];
  const exports = new Set<string>();
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (name: string, kind: SymbolKind, node: ts.Node) => {
    const exported = hasExport(node);
    symbols.push({ name, kind, line: line(node), exported });
    if (exported) exports.add(hasDefault(node) ? "default" : name);
  };

  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) add(st.name?.text ?? "default", "function", st);
    else if (ts.isClassDeclaration(st)) add(st.name?.text ?? "default", "class", st);
    else if (ts.isInterfaceDeclaration(st)) add(st.name.text, "interface", st);
    else if (ts.isTypeAliasDeclaration(st)) add(st.name.text, "type", st);
    else if (ts.isEnumDeclaration(st)) add(st.name.text, "enum", st);
    else if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name))
      add(st.name.text, "namespace", st);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) add(d.name.text, "variable", st);
        else if (hasExport(st)) {
          for (const el of d.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) exports.add(el.name.text);
          }
        }
      }
    } else if (ts.isExportAssignment(st)) exports.add("default");
    else if (ts.isExportDeclaration(st)) {
      if (!st.exportClause) exports.add(`* from ${(st.moduleSpecifier as ts.StringLiteral)?.text}`);
      else if (ts.isNamedExports(st.exportClause))
        for (const el of st.exportClause.elements) exports.add(el.name.text);
      else if (ts.isNamespaceExport(st.exportClause)) exports.add(st.exportClause.name.text);
    }
  }
  return { symbols, exports: [...exports].sort() };
}

/** Strongly connected components with more than one node, or a self-loop (Tarjan). */
export function findCycles(edges: Map<string, Set<string>>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const nodes = [...edges.keys()].sort();

  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of [...(edges.get(v) ?? [])].sort()) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, idx.get(w) ?? 0));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || edges.get(v)?.has(v)) out.push(comp.sort());
    }
  };
  for (const v of nodes) if (!idx.has(v)) strong(v);
  return out.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

/** Builds the code graph for every source file under `root`. Output is deterministic. */
export async function buildCodeGraph(root: string): Promise<CodeGraph> {
  const files = await listSourceFiles(root);
  const known = new Set(files);
  const modules: CodeModule[] = [];
  const pkgImporters = new Map<string, Set<string>>();
  const runtimeEdges = new Map<string, Set<string>>();

  for (const path of files) {
    const text = await readFile(join(root, path), "utf8");
    const imports: ModuleImport[] = extractImports(path, text).map((ref) => {
      if (isRelative(ref.specifier)) {
        const target = resolveRelative(path, ref.specifier, known);
        return target ? { ...ref, target } : ref;
      }
      const pkg = packageOf(ref.specifier);
      if (!pkgImporters.has(pkg)) pkgImporters.set(pkg, new Set());
      pkgImporters.get(pkg)?.add(path);
      return { ...ref, package: pkg };
    });
    const edges = new Set<string>();
    for (const i of imports) if (i.target && i.kind !== "type") edges.add(i.target);
    runtimeEdges.set(path, edges);
    modules.push({ path, imports, ...extractSymbols(path, text) });
  }

  return {
    version: CODE_GRAPH_VERSION,
    modules,
    packages: [...pkgImporters.entries()]
      .map(([name, importers]) => ({ name, importers: importers.size }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    cycles: findCycles(runtimeEdges),
  };
}

/** Folder a module belongs to in summaries (its directory). */
export const folderOf = (path: string) => posix.dirname(path);
