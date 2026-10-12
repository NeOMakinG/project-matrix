/** Context-specific encoders for user-provided answer strings. */

/** HTML text and attribute content. */
export const html = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** A JSX text node: emitted as a string-literal expression, so braces and tags stay inert. */
export const jsxText = (s: string): string => `{${tsString(s)}}`;

/** A TypeScript/JavaScript string literal (JSON is a safe subset; escape line separators too). */
export const tsString = (s: string): string =>
  JSON.stringify(s)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/** Inline markdown: one line, markdown and HTML metacharacters escaped. */
export const md = (s: string): string =>
  s
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_{}[\]()#+\-.!|<>])/g, "\\$1")
    .trim();

/** A Go interpreted string literal (JSON escapes are a valid subset of Go's). */
export const goString = (s: string): string => JSON.stringify(s);

/** A TOML basic string. */
export const tomlString = (s: string): string => JSON.stringify(s);
