import { createHash } from "node:crypto";

export interface RedactOptions {
  /** Extra literal strings (e.g. known secret values) or patterns to mask. */
  denylist?: (string | RegExp)[];
}

const PATTERNS: [RegExp, string][] = [
  // PEM blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE_KEY]"],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[JWT]"],
  // Authorization headers / bearer tokens
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [TOKEN]"],
  // Well-known key prefixes
  [
    /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bphc_[A-Za-z0-9]{20,}\b/g,
    "[KEY]",
  ],
  // key=value / "key": "value" secrets
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|session|cookie)(["']?\s*[:=]\s*["']?)[^\s"'&,;]{4,}/gi,
    "$1$2[REDACTED]",
  ],
  // Emails
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]"],
  // Phone numbers: international (+ and 8-15 digits, optional separators) or grouped national numbers
  [/(?<![\w.\/:-])\+\d(?:[\s.()-]?\d){7,14}(?![\w.-])/g, "[PHONE]"],
  [/(?<![\w.\/:-])\(?0\d{1,4}\)?(?:[\s.-]\d{2,4}){2,4}(?![\w.-])/g, "[PHONE]"],
  // Card-like digit runs (13-19 digits, optional separators)
  [/\b(?:\d[ -]?){13,19}\b/g, "[NUMBER]"],
  // IPv4
  [/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, "[IP]"],
  // IPv6 (full or compressed with at least 3 groups)
  [/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, "[IP]"],
];

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Long, high-entropy, mixed-class tokens are treated as secrets (API keys, session ids). */
function maskHighEntropy(text: string): string {
  return text.replace(/[A-Za-z0-9_+/=-]{24,}/g, (tok) => {
    const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(tok)).length;
    return classes >= 2 && entropy(tok) >= 3.5 ? "[SECRET]" : tok;
  });
}

/** Drops query strings and fragments from every URL in the text. */
export function stripUrlQueries(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1");
}

/**
 * Drops credentials from any URL or DSN (`https://user:pass@host`, `postgres://…`, `mongodb+srv://…`,
 * `redis://:pass@…`, `amqp://…`): everything between `scheme://` and the last `@` before the host.
 */
export function stripUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>]*@/gi, "$1[REDACTED]@");
}

/** Masks secrets and personal data. Applied before anything is stored, sent to an LLM or put in a ticket. */
export function redact(text: string, options: RedactOptions = {}): string {
  let out = stripUrlQueries(stripUserinfo(text));
  for (const item of options.denylist ?? []) {
    out =
      typeof item === "string"
        ? item.length > 0
          ? out.split(item).join("[REDACTED]")
          : out
        : out.replace(
            new RegExp(item.source, item.flags.includes("g") ? item.flags : `${item.flags}g`),
            "[REDACTED]",
          );
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return maskHighEntropy(out);
}

/** Stable pseudonym for a user id: lets us count distinct users without storing the id. */
export function hashUser(projectId: string, userId: string): string {
  return createHash("sha256").update(`${projectId}\u0000${userId}`).digest("hex").slice(0, 16);
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Strips control characters (CR/LF, ANSI) so text can't forge extra lines or headers. */
export function singleLine(text: string, max = 200): string {
  return text.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
