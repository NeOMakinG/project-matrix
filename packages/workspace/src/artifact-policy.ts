import { type AnchoredArtifact, stackDisposableArtifacts } from "@matrix/packs/disposable";
import ts from "typescript";

type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };

function object(value: Literal | undefined): Record<string, Literal> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function disposablePolicy(
  source: string,
  baseTracked: ReadonlySet<string> = new Set(),
): (path: string) => boolean {
  const file = ts.createSourceFile("matrix.config.ts", source, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression>();
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportAssignment(statement)) continue;
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    )
      throw new Error("trusted BASE artifact config must be static");
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        bindings.has(declaration.name.text)
      )
        throw new Error("invalid trusted BASE artifact config binding");
      bindings.set(declaration.name.text, declaration.initializer);
    }
  }
  const literal = (node: ts.Expression, depth = 0): Literal => {
    if (depth > 64) throw new Error("trusted BASE artifact config exceeds depth limit");
    const next = (expression: ts.Expression) => literal(expression, depth + 1);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return next(node.expression);
    if (ts.isIdentifier(node) && bindings.has(node.text)) return next(bindings.get(node.text)!);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineConfig" &&
      node.arguments.length === 1
    )
      return next(node.arguments[0]!);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(next);
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, Literal> = Object.create(null);
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !property.name ||
          !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        )
          throw new Error("trusted BASE artifact config must be static");
        if (Object.hasOwn(result, property.name.text))
          throw new Error("duplicate trusted BASE config property");
        result[property.name.text] = next(property.initializer);
      }
      return result;
    }
    throw new Error("trusted BASE artifact config must be static");
  };
  const exported = file.statements.filter(ts.isExportAssignment);
  if (exported.length !== 1 || exported[0]!.isExportEquals)
    throw new Error("trusted BASE artifact config requires a default export");
  const config = object(literal(exported[0]!.expression));
  const patterns: string[] = [];
  const anchored: AnchoredArtifact[] = [];
  const frontend = object(config.frontend);
  const mobile = object(config.mobile);
  const backend = object(config.backend);
  if (
    frontend.framework === "react" ||
    mobile.framework === "expo" ||
    backend.kind === "node-api" ||
    backend.kind === "fullstack" ||
    object(config.desktop).framework === "tauri"
  ) {
    anchored.push(...stackDisposableArtifacts.node);
  }
  if (frontend.bundler === "next") anchored.push(...stackDisposableArtifacts.next);
  if (mobile.framework === "expo") anchored.push(...stackDisposableArtifacts.expo);
  const declared = object(config.process).disposableArtifacts;
  if (declared !== undefined) {
    if (!Array.isArray(declared) || declared.some((pattern) => typeof pattern !== "string"))
      throw new Error("invalid trusted BASE disposableArtifacts");
    patterns.push(...(declared as string[]));
  }
  const matchers = patterns.map((pattern) => {
    if (
      !pattern ||
      /[\\\x00-\x1f\x7f!\[\]{}:]/.test(pattern) ||
      pattern.startsWith("/") ||
      pattern
        .replace(/\/$/, "")
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw new Error("invalid trusted BASE disposable artifact glob");
    let expression = "";
    for (let index = 0; index < pattern.length; index++) {
      const character = pattern[index]!;
      if (pattern.slice(index, index + 3) === "**/") {
        expression += "(?:[^/]+/)*";
        index += 2;
      } else if (character === "*") expression += "[^/]*";
      else if (character === "?") expression += "[^/]";
      else expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${expression}${pattern.endsWith("/") ? ".+" : ""}$`);
  });
  const segment = (glob: string) =>
    new RegExp(
      `^${glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")}$`,
    );
  const anchoredMatch = (path: string) =>
    anchored.some(({ path: artifact, anchors }) => {
      const directory = artifact.endsWith("/");
      const parts = path.split("/");
      const artifactParts = artifact.replace(/\/$/, "").split("/");
      // Every position where the artifact could start defines a candidate root.
      for (let start = 0; start + artifactParts.length <= parts.length; start++) {
        const root = parts.slice(0, start).join("/");
        const prefix = root ? `${root}/` : "";
        const tail = parts.slice(start, start + artifactParts.length);
        const rest = parts.length - start - artifactParts.length;
        if (directory ? rest < 1 : rest !== 0) continue;
        if (!tail.every((part, index) => segment(artifactParts[index]!).test(part))) continue;
        if (anchors.some((anchor) => baseTracked.has(`${prefix}${anchor}`))) return true;
      }
      return false;
    });
  return (path) =>
    !path.split("/").some((part) => !part || part === "." || part === "..") &&
    (anchoredMatch(path) || matchers.some((matcher) => matcher.test(path)));
}
