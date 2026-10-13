import { knowledge } from "@matrix/config";
import { readFileSafe, safeJoin } from "@matrix/safe-fs";
import ts from "typescript";
import type { z } from "zod";

export type KnowledgeConfig = z.infer<typeof knowledge>;

export async function readKnowledgeConfig(root: string): Promise<KnowledgeConfig> {
  const text = await readFileSafe(root, safeJoin(root, "matrix.config.ts"), {
    maxBytes: 1024 * 1024,
  });
  if (text === null) return {};
  return knowledgeDocument(text).value;
}

function knowledgeDocument(text: string) {
  const source = ts.createSourceFile("matrix.config.ts", text, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          bindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  function unwrap(expression: ts.Expression, depth = 0): ts.Expression {
    if (depth > 32) throw new Error("config expression is too deep");
    if (
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isParenthesizedExpression(expression)
    )
      return unwrap(expression.expression, depth + 1);
    if (ts.isIdentifier(expression) && bindings.has(expression.text))
      return unwrap(bindings.get(expression.text)!, depth + 1);
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "defineConfig" &&
      expression.arguments.length === 1
    )
      return unwrap(expression.arguments[0]!, depth + 1);
    return expression;
  }
  function literal(expression: ts.Expression, depth = 0): unknown {
    if (depth > 32) throw new Error("knowledge config is too deep");
    const value = unwrap(expression);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
    if (ts.isObjectLiteralExpression(value)) {
      const entries = value.properties.map((property) => {
        if (
          !ts.isPropertyAssignment(property) ||
          !property.name ||
          !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        )
          throw new Error("knowledge config must use literal properties");
        return [property.name.text, literal(property.initializer, depth + 1)];
      });
      return Object.fromEntries(entries);
    }
    throw new Error("knowledge config must be static literal data");
  }
  const exported = source.statements.find(ts.isExportAssignment);
  if (!exported) throw new Error("matrix.config.ts must have a default export");
  const config = unwrap(exported.expression);
  if (!ts.isObjectLiteralExpression(config))
    throw new Error("matrix config must be a static object");
  let raw: unknown = {};
  let knowledgeProperty: ts.ObjectLiteralElementLike | undefined;
  for (const property of config.properties) {
    if (ts.isSpreadAssignment(property))
      throw new Error("matrix config spreads cannot be resolved safely");
    if (
      property.name &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === "knowledge"
    ) {
      knowledgeProperty = property;
      if (ts.isPropertyAssignment(property)) raw = literal(property.initializer);
      else if (ts.isShorthandPropertyAssignment(property)) raw = literal(property.name);
      else throw new Error("knowledge config must be static literal data");
    }
  }
  return { value: knowledge.parse(raw), raw, config, source, knowledgeProperty };
}

export function withKnowledgeConfig(text: string, config: KnowledgeConfig): string {
  const document = knowledgeDocument(text);
  const value = knowledge.parse(config);
  if (JSON.stringify(document.value) === JSON.stringify(value)) return text;
  const property = `knowledge: ${JSON.stringify({ ...(document.raw as Record<string, unknown>), ...value }, null, 2)}`;
  if (document.knowledgeProperty) {
    const start = document.knowledgeProperty.getStart(document.source);
    const end = document.knowledgeProperty.getEnd();
    return text.slice(0, start) + property + text.slice(end);
  }
  const end = document.config.getEnd() - 1;
  const last = document.config.properties.at(-1);
  const comma = last && !text.slice(last.getEnd(), end).trimStart().startsWith(",") ? "," : "";
  return `${text.slice(0, end)}${comma}\n${property}\n${text.slice(end)}`;
}

export async function readKnowledgeJson(root: string, path: string): Promise<unknown> {
  const text = await readFileSafe(root, safeJoin(root, path), { maxBytes: 4 * 1024 * 1024 });
  if (text === null) throw new Error(`missing knowledge file: ${path}`);
  const raw: unknown = JSON.parse(text);
  function bound(value: unknown, depth: number): void {
    if (depth > 32) throw new Error("knowledge data is too deep");
    if (Array.isArray(value)) {
      if (value.length > 10000) throw new Error("knowledge collection is too large");
      for (const child of value) bound(child, depth + 1);
    } else if (value !== null && typeof value === "object") {
      if (Object.keys(value).length > 10000) throw new Error("knowledge object is too large");
      for (const child of Object.values(value)) bound(child, depth + 1);
    } else if (typeof value === "string" && value.length > 65536)
      throw new Error("knowledge string is too large");
  }
  bound(raw, 0);
  return raw;
}

export async function readArchitectureReference(root: string, config: KnowledgeConfig) {
  if (!config.architectureGraph) return undefined;
  const graph = await readKnowledgeJson(root, config.architectureGraph.path);
  if (graph === null || typeof graph !== "object" || Array.isArray(graph))
    throw new Error("architecture reference must be a JSON object");
  return { path: config.architectureGraph.path, readOnly: true as const, graph };
}
