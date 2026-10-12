import { secretNeedles } from "@matrix/sandbox";

export function redactNativeDiagnostic(secrets: readonly string[]) {
  const needles = [
    ...new Set(
      secrets
        .filter(Boolean)
        .flatMap((secret) => [secret, ...secretNeedles(secret).map((needle) => needle.toString())]),
    ),
  ].sort((left, right) => right.length - left.length);
  return (value: string): string => {
    let text = value;
    for (const needle of needles) text = text.split(needle).join("[REDACTED]");
    return text
      .replace(
        /^.*\b(?:argv|headers|env(?:ironment)?)\b\s*[:=][\s\S]*$/im,
        "[REDACTED execution context]",
      )
      .replace(/(?:mxr_[a-zA-Z0-9]+|sk-[a-zA-Z0-9_-]+)/g, "[REDACTED]")
      .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
      .replace(
        /^.*(?:command failed:|\bargv\b|\bheaders\b|\benv(?:ironment)?\b\s*[:=]|--(?:env|header|api-key|token)\b|\b(?:authorization|cookie|x-api-key)\s*:).*$/gim,
        "[REDACTED execution context]",
      )
      .replace(/([A-Z][A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g, "$1[REDACTED]")
      .replace(
        /([\w-]*(?:key|token|secret|password)[\w-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        "$1[REDACTED]",
      );
  };
}
