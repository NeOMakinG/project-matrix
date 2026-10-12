import { inScope } from "@matrix/graph";
import ts from "typescript";
import type { Hit, SourceIndex } from "./checks";
import type { RuleCheck } from "./schema";

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

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);

const calleeText = (expr: ts.Expression): string | undefined => {
  if (ts.isParenthesizedExpression(expr)) return calleeText(expr.expression);
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const left = calleeText(expr.expression);
    return left ? `${left}.${expr.name.text}` : undefined;
  }
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)) {
    const left = calleeText(expr.expression);
    return left ? `${left}.${expr.argumentExpression.text}` : undefined;
  }
  if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr))
    return calleeText(expr.expression);
  return undefined;
};

/** `fetch`, `globalThis.fetch`, `window["fetch"]`, `(globalThis as any).fetch` all name `fetch`. */
function textMatches(callee: string, text: string | undefined): boolean {
  if (!text) return false;
  if (text === callee) return true;
  const [head, ...rest] = text.split(".");
  return head !== undefined && GLOBAL_OBJECTS.has(head) && rest.join(".") === callee;
}

const declName = (d: ts.Declaration | undefined) => {
  const n = d ? ts.getNameOfDeclaration(d) : undefined;
  return n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined;
};

/** True when a call resolves to the ambient (lib / @types) declaration of global `name`. */
function resolvesToGlobal(checker: ts.TypeChecker, call: ts.CallExpression, name: string): boolean {
  const ambient = (d: ts.Declaration | undefined) =>
    declName(d) === name && d?.getSourceFile().isDeclarationFile === true;
  if (ambient(checker.getResolvedSignature(call)?.declaration as ts.Declaration | undefined))
    return true;
  // fetch.call(...), fetch.apply(...), fetch.bind(...)(...)
  const target = ts.isPropertyAccessExpression(call.expression) ? call.expression : undefined;
  if (target && ["call", "apply"].includes(target.name.text)) {
    const sigs = checker.getTypeAtLocation(target.expression).getCallSignatures();
    return sigs.some((s) => ambient(s.declaration as ts.Declaration | undefined));
  }
  return false;
}

/**
 * ast-grep style call patterns. Single-name globals (`fetch($$$)`) are matched through the type
 * checker, so aliases (`const f = fetch; f()`), `globalThis.fetch()`, `window["fetch"]()` and
 * `fetch.call()` are caught. Dotted callees (`db.execute($A)`) match by text.
 */
export async function callPatternHits(
  check: Extract<RuleCheck, { type: "call-pattern" }>,
  index: SourceIndex,
): Promise<Hit[]> {
  const pattern = parseCallPattern(check.pattern);
  const global = !pattern.callee.includes(".");
  const files = index.files.filter((f) => inScope(f, check));
  if (files.length === 0) return [];
  const program = await index.program(files);
  const checker = program.getTypeChecker();
  const hits: Hit[] = [];

  for (const file of files) {
    const sf = program.getSourceFile(index.absolute(file)) ?? (await index.sourceFile(file));
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        (pattern.arity === undefined || node.arguments.length === pattern.arity) &&
        (textMatches(pattern.callee, calleeText(node.expression)) ||
          (global && resolvesToGlobal(checker, node, pattern.callee)))
      ) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        hits.push({ file, line, message: `calls ${pattern.callee}()` });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}
