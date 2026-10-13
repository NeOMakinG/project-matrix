import { applyEdits, modify, type ParseError, parse, printParseErrorCode } from "jsonc-parser";

/** A config problem described by position only; never carries file content. */
export class ConfigError extends Error {}

export function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** Parses JSON/JSONC, reporting only "file is not valid … at line N, column M (code)". */
export function parseJsonc(file: string, text: string): unknown {
  if (!text.trim()) return {};
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  const first = errors[0];
  if (first) {
    const { line, column } = lineCol(text, first.offset);
    throw new ConfigError(
      `${file} is not valid JSON at line ${line}, column ${column} (${printParseErrorCode(first.error)})`,
    );
  }
  if (text.trim() && (value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new ConfigError(`${file} does not contain a JSON object at the top level`);
  }
  return value;
}

/** Sets `path` to `value` keeping comments, formatting and every other entry as they are. */
export function setJsonc(file: string, text: string, path: string[], value: unknown): string {
  parseJsonc(file, text);
  const source = text.trim() ? text : "{}\n";
  const edits = modify(source, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  return applyEdits(source, edits);
}

export function hasJsoncPath(file: string, text: string, path: string[]): boolean {
  let node = parseJsonc(file, text) as Record<string, unknown> | undefined;
  for (const key of path) {
    if (!node || typeof node !== "object") return false;
    node = node[key] as Record<string, unknown> | undefined;
  }
  return node !== undefined;
}

const ANY_HEADER = /^\s*\[/;

function tableHeader(name: string): RegExp {
  return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${name}|"${name}")\\s*\\]\\s*(?:#.*)?$`);
}

/**
 * Replaces or appends only the `[mcp_servers.matrix]` table in a TOML file, leaving every other
 * line untouched. Refuses files where a line-based edit could be wrong: multi-line strings, or the
 * matrix server defined via dotted keys / inline tables / sub-tables.
 */
export function setTomlMatrixTable(
  file: string,
  text: string,
  block: string,
  name = "matrix",
): string {
  if (/"""|'''/.test(text))
    throw new ConfigError(`${file} uses multi-line strings; add the matrix table by hand`);
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (
      new RegExp(`^\\[\\s*mcp_servers\\s*\\.\\s*(?:${name}|"${name}")\\s*\\.`).test(trimmed) ||
      new RegExp(`^mcp_servers\\s*\\.\\s*(?:${name}|"${name}")\\s*[.=]`).test(trimmed) ||
      new RegExp(`^(?:${name}|"${name}")\\s*=\\s*\\{`).test(trimmed)
    ) {
      throw new ConfigError(
        `${file} defines mcp_servers.${name} in a form Matrix can't edit safely (line ${i + 1}); add it by hand`,
      );
    }
  }
  const start = lines.findIndex((line) => tableHeader(name).test(line));
  if (lines.filter((line) => tableHeader(name).test(line)).length > 1)
    throw new ConfigError(`${file} has duplicate mcp_servers.${name} tables`);
  if (start === -1) return `${text.replace(/\s*$/, "")}${text.trim() ? "\n\n" : ""}${block}`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_HEADER.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const tail = lines.slice(end);
  return [
    ...lines.slice(0, start),
    ...block.replace(/\n$/, "").split("\n"),
    ...(tail.length ? ["", ...tail] : [""]),
  ].join("\n");
}

export function hasTomlMatrixTable(text: string, name = "matrix"): boolean {
  return text.split("\n").some((line) => tableHeader(name).test(line));
}

export function tomlMatrixTable(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => tableHeader(name).test(line));
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && ANY_HEADER.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}
