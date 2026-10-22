/**
 * Issue titles, bodies, labels and comments are untrusted (anyone with workspace access writes
 * them, and they flow into agent prompts). Strip invisible characters that can hide instructions:
 * zero-width, bidi overrides/isolates, tag characters, variation-selector supplement, soft hyphen,
 * fillers and C0/C1 controls other than tab/newline/CR.
 */
const HIDDEN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

export function sanitizeUntrusted(text: string): string {
  return text.normalize("NFC").replace(HIDDEN, "");
}
