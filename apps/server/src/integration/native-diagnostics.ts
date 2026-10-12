import { secretNeedles } from "@matrix/sandbox";

const MAX_DIAGNOSTIC_CHARACTERS = 8192;
const EXECUTION_CONTEXT = /\b(?:argv|headers|env(?:ironment)?)\b\s*[:=]/i;
const EXECUTION_LINE =
  /(?:command failed:|\bargv\b|\bheaders\b|\benv(?:ironment)?\b\s*[:=]|--(?:env|header|api-key|token)\b|\b(?:authorization|cookie|x-api-key)\s*:)/i;

export function redactNativeDiagnostic(secrets: readonly string[]) {
  const needles = [
    ...new Set(
      secrets
        .filter(Boolean)
        .flatMap((secret) => [secret, ...secretNeedles(secret).map((needle) => needle.toString())]),
    ),
  ].sort((left, right) => right.length - left.length);
  const literals = needles.map((needle) => needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const values = new RegExp(
    [
      ...literals,
      "(?:mxr_[a-zA-Z0-9]+|sk-[a-zA-Z0-9_-]+)",
      "(?<bearer>\\b[Bb][Ee][Aa][Rr][Ee][Rr]\\s+)[^\\s\"',;]+",
    ].join("|"),
    "g",
  );
  return (value: string): string => {
    if (value.length > MAX_DIAGNOSTIC_CHARACTERS)
      return "[REDACTED oversized diagnostic; truncated]";
    const context = EXECUTION_CONTEXT.exec(value);
    const text = context
      ? `${value.slice(0, value.lastIndexOf("\n", context.index) + 1)}[REDACTED execution context]`
      : value;
    return text
      .split("\n")
      .map((line) => (EXECUTION_LINE.test(line) ? "[REDACTED execution context]" : line))
      .join("\n")
      .replace(values, (_match: string, bearer: string | undefined) =>
        bearer ? "Bearer [REDACTED]" : "[REDACTED]",
      )
      .replace(
        /(?<![\w-])([\w-]+)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/g,
        (assignment, name: string, separator: string) =>
          /key|token|secret|password/i.test(name) ||
          (separator.trimStart().startsWith("=") && /[A-Z][A-Z0-9_]*$/.test(name))
            ? `${name}${separator}[REDACTED]`
            : assignment,
      );
  };
}
