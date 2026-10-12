import {
  extractImports,
  type ImportRef,
  inScope,
  isRelative,
  lineIndex,
  parseSource,
  resolveRelative,
  type Scope,
} from "@matrix/graph";
import picomatch from "picomatch";
import ts from "typescript";
import type { RuleCheck } from "./schema";

export interface Hit {
  file: string;
  line: number;
  message: string;
}

/** Lazily reads and caches file text, parsed imports and source trees. */
export interface SourceIndex {
  files: string[];
  known: ReadonlySet<string>;
  text(file: string): Promise<string>;
  imports(file: string): Promise<ImportRef[]>;
  sourceFile(file: string): Promise<ts.SourceFile>;
}

const CALL_RE = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\((.*)\)$/s;

interface CallPattern {
  callee: string;
  /** Exact argument count, or undefined for `$$$` (any). */
  arity: number | undefined;
}

/** Parses the supported subset of ast-grep patterns: `callee(...)` with metavariable args. */
export function parseCallPattern(pattern: string): CallPattern {
  const m = CALL_RE.exec(pattern.trim());
  if (!m?.[1]) throw new Error(`unsupported call pattern "${pattern}" (expected callee($$$))`);
  const args = (m[2] ?? "").trim();
  if (args === "$$$") return { callee: m[1], arity: undefined };
  if (args === "") return { callee: m[1], arity: 0 };
  const parts = args.split(",").map((a) => a.trim());
  if (!parts.every((p) => /^\$[A-Z_][A-Z0-9_]*$/.test(p)))
    throw new Error(`call pattern args must be metavariables ($A) or $$$: "${pattern}"`);
  return { callee: m[1], arity: parts.length };
}

const calleeText = (expr: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const left = calleeText(expr.expression);
    return left ? `${left}.${expr.name.text}` : undefined;
  }
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return "this";
  return undefined;
};

const filesInScope = (index: SourceIndex, check: Scope) =>
  index.files.filter((f) => inScope(f, check));

/** Runs one rule body against the indexed sources. */
export async function runCheck(check: RuleCheck, index: SourceIndex): Promise<Hit[]> {
  const hits: Hit[] = [];
  switch (check.type) {
    case "forbidden-import": {
      const re = new RegExp(check.import);
      for (const file of filesInScope(index, check))
        for (const ref of await index.imports(file))
          if ((check.includeTypeImports || ref.kind !== "type") && re.test(ref.specifier))
            hits.push({ file, line: ref.line, message: `imports "${ref.specifier}"` });
      break;
    }
    case "boundary": {
      const disallowed = picomatch(check.disallow, { dot: true });
      const allowed = check.allow ? picomatch(check.allow, { dot: true }) : () => false;
      for (const file of filesInScope(index, check))
        for (const ref of await index.imports(file)) {
          if (!isRelative(ref.specifier)) continue;
          if (ref.kind === "type" && !check.includeTypeImports) continue;
          const target = resolveRelative(file, ref.specifier, index.known);
          if (target && disallowed(target) && !allowed(target))
            hits.push({ file, line: ref.line, message: `imports ${target} across a boundary` });
        }
      break;
    }
    case "call-pattern": {
      const pattern = parseCallPattern(check.pattern);
      for (const file of filesInScope(index, check)) {
        const sf = await index.sourceFile(file);
        const visit = (node: ts.Node): void => {
          if (
            ts.isCallExpression(node) &&
            calleeText(node.expression) === pattern.callee &&
            (pattern.arity === undefined || node.arguments.length === pattern.arity)
          ) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            hits.push({ file, line, message: `calls ${pattern.callee}()` });
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
      break;
    }
    case "regex": {
      const flags = (check.flags ?? "").replace("g", "");
      const re = new RegExp(check.pattern, `${flags}g`);
      for (const file of filesInScope(index, check)) {
        const text = await index.text(file);
        const lineOf = lineIndex(text);
        for (const m of text.matchAll(re))
          hits.push({ file, line: lineOf(m.index ?? 0), message: `matches /${check.pattern}/` });
      }
      break;
    }
    case "required-header": {
      const re = new RegExp(check.header, "m");
      for (const file of filesInScope(index, check)) {
        const head = (await index.text(file)).split("\n").slice(0, 10).join("\n");
        if (!re.test(head)) hits.push({ file, line: 1, message: "missing required header" });
      }
      break;
    }
  }
  return hits;
}

export function createSourceIndex(
  files: string[],
  read: (file: string) => Promise<string>,
): SourceIndex {
  const texts = new Map<string, Promise<string>>();
  const imports = new Map<string, Promise<ImportRef[]>>();
  const trees = new Map<string, Promise<ts.SourceFile>>();
  const text = (file: string) => {
    let p = texts.get(file);
    if (!p) {
      p = read(file);
      texts.set(file, p);
    }
    return p;
  };
  return {
    files,
    known: new Set(files),
    text,
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
  };
}
