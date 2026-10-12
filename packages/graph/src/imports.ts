import { posix } from "node:path";
import ts from "typescript";
import { SOURCE_EXTENSIONS } from "./files";

export type ImportKind = "static" | "dynamic" | "require" | "reexport" | "type";

export interface ImportRef {
  specifier: string;
  line: number;
  kind: ImportKind;
  /** `import(expr)` / `require(expr)` with a non-literal argument: cannot be resolved statically. */
  computed?: true;
}

export const COMPUTED_SPECIFIER = "<computed>";

/** Returns a function mapping a character offset to its 1-based line. */
export function lineIndex(text: string): (pos: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const scriptKind = (path: string) =>
  path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

export const parseSource = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));

/** Every module specifier a file references, with its line and how it is referenced. */
export function extractImports(path: string, text: string): ImportRef[] {
  const sf = parseSource(path, text);
  const refs: ImportRef[] = [];
  const push = (node: ts.Node, specifier: string, kind: ImportKind) =>
    refs.push({
      specifier,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      kind,
    });

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.importClause?.isTypeOnly === true;
      push(node, node.moduleSpecifier.text, typeOnly ? "type" : "static");
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      push(node, node.moduleSpecifier.text, node.isTypeOnly ? "type" : "reexport");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      push(node, node.moduleReference.expression.text, "require");
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const arg = node.arguments[0];
      const kind: ImportKind | undefined =
        node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? "dynamic"
          : ts.isIdentifier(node.expression) && node.expression.text === "require"
            ? "require"
            : undefined;
      if (kind && arg && ts.isStringLiteralLike(arg)) push(node, arg.text, kind);
      else if (kind) {
        refs.push({
          specifier: COMPUTED_SPECIFIER,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          kind,
          computed: true,
        });
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      push(node, node.argument.literal.text, "type");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

export const isRelative = (specifier: string) =>
  specifier === "." ||
  specifier === ".." ||
  specifier.startsWith("./") ||
  specifier.startsWith("../");

/** Package name of a bare specifier: `@scope/pkg/sub` -> `@scope/pkg`, `node:fs` -> `node:fs`. */
export function packageOf(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/**
 * Resolves a relative specifier against the importing file, using the set of known files.
 * Handles extension-less imports, `.js` written for `.ts` sources, and directory index files.
 */
export function resolveRelative(
  from: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = base.replace(/\.(m|c)?jsx?$/, "");
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => `${stem}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((c) => known.has(c));
}
