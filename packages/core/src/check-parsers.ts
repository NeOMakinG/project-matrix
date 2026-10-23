import { createHash } from "node:crypto";
import { REPORT_MOUNT } from "./ports.js";
import type { CheckCommand, CheckParser } from "./types.js";

/**
 * Parsers that turn a check command's raw output into a list of failure identities, so a run can
 * be compared to the same command on the base commit. Output is untrusted (the code under test
 * prints it): sizes are bounded, JSON goes through JSON.parse only, and every identity is
 * sanitized before it can reach a prompt or a tracker comment.
 */

export const CHECK_PARSERS = [
  "eslint-json",
  "tsc",
  "node-test-tap",
  "vitest-json",
  "exit-code",
] as const satisfies readonly CheckParser[];

/** Largest output a parser looks at; anything bigger is "unparseable" (fail closed). */
export const MAX_PARSE_BYTES = 16 * 1024 * 1024;
/** More failures than this cannot be compared reliably: treated as unparseable. */
export const MAX_FAILURES = 20_000;
const MAX_IDENTITY = 240;
const MAX_JSON_CANDIDATES = 12;
/** Line-based parsers truncate (never drop) longer lines: bounds regex backtracking on hostile output. */
const MAX_LINE = 4096;
const lines = (text: string) =>
  text.split("\n").map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l));

/** One-line, prompt-safe failure identity: no control/bidi chars, no backticks, bounded. */
export function sanitizeFailure(text: string, max = MAX_IDENTITY): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * One failure: `key` identifies it for the base comparison (built from the FULL normalized
 * message, never truncated, so head and base keys match byte for byte); `text` is the bounded,
 * prompt-safe display line. A bare string is its own key and text (tests, legacy callers).
 */
export interface FailureId {
  key: string;
  text: string;
}
export type Failure = FailureId | string;
export const failureKey = (f: Failure): string => (typeof f === "string" ? f : f.key);
export const failureText = (f: Failure): string => (typeof f === "string" ? f : f.text);

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g;
const TMP =
  /(?:\/private)?\/var\/folders\/[^\s/]+\/[^\s/]+\/[TC]\/[^\s/]+|(?:\/private)?\/tmp\/[^\s/]+/g;

/**
 * Deterministic message normalization for failure keys: line endings, ANSI escapes and control
 * characters removed, known roots stripped, temp dirs replaced, every whitespace run collapsed
 * to one space, trimmed. Never truncates. `positions` also masks `12:5` / `(12,5)` positions
 * (diagnostic messages); test names keep their digits since they are the identity itself.
 */
export function normalizeMessage(
  text: string,
  roots: readonly string[] = [],
  positions = true,
): string {
  let s = text.replace(/\r\n?/g, "\n").replace(ANSI, "");
  for (const root of roots) {
    const r = root.replace(/\/+$/, "");
    if (!r) continue;
    const esc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Only where a path starts (line start, whitespace, quote, bracket...), never mid-path.
    s = s.replace(new RegExp(`(^|[\\s'"\`(\\[{<=:,])${esc}/`, "gm"), "$1");
  }
  s = s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(TMP, "<tmp>");
  if (positions) s = s.replace(/\b\d+:\d+\b/g, "<n>:<n>").replace(/\(\d+,\s*\d+\)/g, "(<n>,<n>)");
  return s.replace(/\s+/g, " ").trim();
}

const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
/** Key parts longer than this are hashed (keys stay bounded; still exact). */
const MAX_KEY_PART = 512;
const keyPart = (s: string) => (s.length > MAX_KEY_PART ? `#${sha16(s)}` : s);

/**
 * A failure from its parts: key `${tool}:${relPath}:${ruleId}:${sha256(message)[0..16]}`,
 * display `path: rule: message` (or `display(path, rule, message)`), sanitized and bounded.
 */
export function makeFailure(
  tool: string,
  path: string,
  rule: string,
  message: string,
  roots: readonly string[] = [],
  display?: (path: string, rule: string, message: string) => string,
): FailureId {
  const p = normalizeMessage(path, roots, false);
  const r = normalizeMessage(rule, [], false);
  const m = normalizeMessage(message, roots, tool === "eslint" || tool === "tsc");
  const shown = display ? display(p, r, m) : [p, r, m].filter(Boolean).join(": ");
  return { key: `${tool}:${keyPart(p)}:${keyPart(r)}:${sha16(m)}`, text: sanitizeFailure(shown) };
}

const base = (token: string) => token.split("/").pop() ?? token;
const hasFlag = (cmd: string[], flags: string[]) =>
  cmd.some((t) => flags.some((f) => t === f || t.startsWith(`${f}=`)));

/** Explicit parser, else one recognizable from the argv, else tsc for typecheck, else exit-code. */
export function resolveParser(check: CheckCommand): CheckParser {
  if (check.parser) return check.parser;
  const names = check.cmd.map(base);
  if (names.includes("eslint")) return "eslint-json";
  if (names.includes("vitest")) return "vitest-json";
  if (names.includes("tsc") || check.kind === "typecheck") return "tsc";
  if (names.includes("node") && check.cmd.includes("--test")) return "node-test-tap";
  return "exit-code";
}

/**
 * The argv actually run: structured-output flags appended for eslint/vitest. Direct binaries get
 * the flag itself; `npm run x` needs `--` to forward it; pnpm/yarn/bun `run` forward it as is.
 */
export function checkArgv(check: CheckCommand): string[] {
  const parser = resolveParser(check);
  const extra =
    parser === "eslint-json" && !hasFlag(check.cmd, ["--format", "-f"])
      ? ["--format", "json"]
      : parser === "vitest-json" && !hasFlag(check.cmd, ["--reporter"])
        ? ["--reporter=json"]
        : [];
  if (!extra.length) return [...check.cmd];
  const names = check.cmd.map(base);
  if (names.includes("eslint") || names.includes("vitest")) return [...check.cmd, ...extra];
  const runner = names[0];
  if (runner === "npm" && check.cmd.includes("run"))
    return [...check.cmd, ...(check.cmd.includes("--") ? [] : ["--"]), ...extra];
  if ((runner === "pnpm" || runner === "yarn" || runner === "bun") && check.cmd.length > 1)
    return [...check.cmd, ...extra];
  // A shell or wrapper we cannot extend safely: the command must emit the format itself.
  return [...check.cmd];
}

/** Largest structured report file the host reads back from a check (eslint JSON can be 10+ MB). */
export const MAX_REPORT_BYTES = 64 * 1024 * 1024;

/** What a check actually runs: argv, extra env, and the report file it writes (if any). */
export interface CheckInvocation {
  cmd: string[];
  env?: Record<string, string>;
  report?: { name: string; maxBytes: number };
}

const forwardable = (cmd: string[]) => {
  const runner = cmd.map(base)[0];
  if (runner === "npm") return cmd.includes("run") || cmd.includes("test");
  return (runner === "pnpm" || runner === "yarn" || runner === "bun") && cmd.length > 1;
};

/** Appends flags to a direct binary or a package-manager script (`npm run x -- flags`). */
function append(cmd: string[], tool: string, extra: string[]): string[] | undefined {
  if (cmd.map(base).includes(tool)) return [...cmd, ...extra];
  if (!forwardable(cmd)) return undefined;
  const npm = base(cmd[0] ?? "") === "npm";
  return [...cmd, ...(npm && !cmd.includes("--") ? ["--"] : []), ...extra];
}

/**
 * The invocation for a check with a structured parser: the report goes to a file under
 * REPORT_MOUNT (read back host-side with a byte cap) instead of one huge stdout line, so stdout
 * stays human logs. `token` (random per run) names the report file. A command that already
 * picks its own reporter/output, or a wrapper we cannot extend, keeps the stdout path.
 */
export function checkInvocation(check: CheckCommand, token: string): CheckInvocation {
  const parser = resolveParser(check);
  const cmd = check.cmd;
  if (!/^[A-Za-z0-9-]{1,40}$/.test(token)) throw new Error("invalid report token");
  const name = `report-${token}.${parser === "node-test-tap" ? "tap" : "json"}`;
  const report = { name, maxBytes: MAX_REPORT_BYTES };
  const path = `${REPORT_MOUNT}/${name}`;
  if (parser === "eslint-json" && !hasFlag(cmd, ["-o", "--output-file"])) {
    const json = !hasFlag(cmd, ["--format", "-f"]);
    const argv = json ? append(cmd, "eslint", ["--format", "json", "-o", path]) : undefined;
    if (argv) return { cmd: argv, report };
  }
  const ownOutput = cmd.some((t) => t.startsWith("--outputFile"));
  if (parser === "vitest-json" && !ownOutput && !hasFlag(cmd, ["--reporter"])) {
    const extra = ["--reporter=default", "--reporter=json", `--outputFile.json=${path}`];
    const argv = append(cmd, "vitest", extra);
    if (argv) return { cmd: argv, report };
  }
  if (parser === "node-test-tap" && !hasFlag(cmd, ["--test-reporter"])) {
    // NODE_OPTIONS reaches `node --test` through npm/pnpm scripts too; argv after the test
    // patterns would be ignored. TAP goes to the file, the spec reporter keeps stdout readable.
    const opts = [
      "--test-reporter=tap",
      `--test-reporter-destination=${path}`,
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
    ];
    return { cmd: [...cmd], env: { NODE_OPTIONS: opts.join(" ") }, report };
  }
  return { cmd: checkArgv(check) };
}

/** Relative path for absolute paths under a known root (host worktree or container mount). */
export function relPath(path: string, roots: readonly string[]): string {
  for (const root of roots) {
    const r = root.endsWith("/") ? root : `${root}/`;
    if (path.startsWith(r)) return path.slice(r.length);
  }
  return path;
}

/**
 * The single report in the output: JSON.parse on candidate slices that start a line with `open`.
 * Code under test can print a forged report, so two accepted reports (or too many candidates to
 * check them all) are ambiguous and yield `null`: the caller fails closed.
 */
function findJson(
  text: string,
  open: "[" | "{",
  accept: (v: unknown) => boolean,
): unknown | null | undefined {
  const close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  if (end < 0) return undefined;
  let tries = 0;
  let found: unknown;
  let at = text.startsWith(open) ? 0 : text.indexOf(`\n${open}`);
  while (at >= 0 && at < end) {
    if (tries++ >= MAX_JSON_CANDIDATES) return null;
    const start = text[at] === "\n" ? at + 1 : at;
    for (const stop of [text.indexOf("\n", start), end + 1]) {
      if (stop <= start) continue;
      try {
        const value: unknown = JSON.parse(text.slice(start, stop));
        if (!accept(value)) continue;
        if (found !== undefined) return null;
        found = value;
        break;
      } catch {
        // not this slice
      }
    }
    at = text.indexOf(`\n${open}`, start);
  }
  return found;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** `null` = the output could not be parsed confidently (callers fail closed). */
export type Failures = Failure[] | null;

function eslint(text: string, roots: readonly string[]): Failures {
  const isReport = (v: unknown) =>
    Array.isArray(v) && v.every((f) => typeof obj(f).filePath === "string");
  const report = findJson(text, "[", isReport) as unknown[] | null | undefined;
  if (report === null) return null;
  if (report) {
    const out: FailureId[] = [];
    for (const file of report) {
      const f = obj(file);
      const path = relPath(str(f.filePath), roots);
      for (const m of Array.isArray(f.messages) ? f.messages : []) {
        const msg = obj(m);
        // severity 2 = error; warnings never fail eslint, so they are not failures.
        if (msg.severity !== 2 && msg.fatal !== true) continue;
        out.push(makeFailure("eslint", path, str(msg.ruleId) || "fatal", str(msg.message), roots));
        if (out.length > MAX_FAILURES) return null;
      }
    }
    return out;
  }
  // Fallback: the default "stylish" format (a path line, then `  12:5  error  msg  rule`).
  const out: FailureId[] = [];
  let file = "";
  for (const line of lines(text)) {
    if (/^(\/|\S+\.\w+$)/.test(line) && !line.includes("  ")) file = relPath(line.trim(), roots);
    const m = /^\s+\d+:\d+\s+error\s+(.+?)(?:\s{2,}(\S+))?\s*$/.exec(line);
    if (m && file) out.push(makeFailure("eslint", file, m[2] ?? "fatal", m[1] as string, roots));
    if (out.length > MAX_FAILURES) return null;
  }
  return out;
}

function tsc(text: string, roots: readonly string[]): Failures {
  const out: FailureId[] = [];
  // `a.ts(12,5): error TS2322: msg`, pretty `a.ts:12:5 - error TS2322: msg`, or a global error.
  const re = /^(\S[^(:\n]*?)(?:\(\d+,\d+\):|:\d+:\d+ -) error (TS\d+): (.*)$/;
  for (const raw of lines(text)) {
    const line = raw.trim();
    const m = re.exec(line);
    const global = m ? undefined : /^error (TS\d+): (.*)$/.exec(line);
    if (m)
      out.push(
        makeFailure("tsc", relPath(m[1] as string, roots), m[2] as string, m[3] as string, roots),
      );
    else if (global)
      out.push(makeFailure("tsc", "", global[1] as string, global[2] as string, roots));
    if (out.length > MAX_FAILURES) return null;
  }
  return out;
}

/** node:test TAP (`not ok N - name`, nested `# Subtest:`) and the spec reporter (`✖ name`). */
function nodeTest(text: string, roots: readonly string[]): Failures {
  const out: FailureId[] = [];
  const stack: { indent: number; name: string }[] = [];
  const parents = (indent: number) => {
    while (stack.length && (stack.at(-1) as { indent: number }).indent >= indent) stack.pop();
    return stack.map((s) => s.name);
  };
  const push = (indent: number, name: string) => {
    const path = [...parents(indent), relPath(name.trim(), roots)].join(" > ");
    out.push(makeFailure("node-test", "", "", path, roots));
  };
  for (const line of lines(text)) {
    if (/^\s*✖ failing tests:\s*$/.test(line)) break; // spec reporter repeats failures below
    const indent = line.length - line.trimStart().length;
    const sub = /^\s*(?:# Subtest:|▶) (.+?)(?: \([\d.]+m?s\))?\s*$/.exec(line);
    if (sub) {
      parents(indent);
      stack.push({ indent, name: relPath(sub[1] as string, roots) });
      continue;
    }
    const tap = /^\s*not ok \d+ - (.*?)(\s+#\s*(TODO|SKIP)\b.*)?$/i.exec(line);
    if (tap) {
      if (!tap[3]) push(indent, tap[1] as string);
    } else {
      const spec = /^\s*✖ (.+?)(?: \([\d.]+m?s\))?(\s+#\s*TODO\b.*)?\s*$/.exec(line);
      if (spec && !spec[2]) push(indent, spec[1] as string);
    }
    if (out.length > MAX_FAILURES) return null;
  }
  return out;
}

function vitest(text: string, roots: readonly string[]): Failures {
  const report = findJson(text, "{", (v) => Array.isArray(obj(v).testResults));
  if (report === null || report === undefined) return null;
  const out: FailureId[] = [];
  const shown = (p: string, _r: string, m: string) => `${p} > ${m}`;
  for (const file of obj(report).testResults as unknown[]) {
    const f = obj(file);
    const path = relPath(str(f.name), roots);
    const cases = Array.isArray(f.assertionResults) ? f.assertionResults.map(obj) : [];
    const failed = cases.filter((c) => c.status === "failed");
    for (const c of failed)
      out.push(makeFailure("vitest", path, "", str(c.fullName) || str(c.title), roots, shown));
    // A file that failed to load has no failed assertions of its own.
    if (f.status === "failed" && failed.length === 0)
      out.push(makeFailure("vitest", path, "", "(file failed)", roots, shown));
    if (out.length > MAX_FAILURES) return null;
  }
  return out;
}

const PARSE = { "eslint-json": eslint, tsc, "node-test-tap": nodeTest, "vitest-json": vitest };

/**
 * Failure identities of one run (sanitized), `[]` for a passing run, or null when a failing run's
 * output yields nothing recognizable (or is too large) and so cannot be compared. A report file
 * the check wrote (see `checkInvocation`) is parsed instead of stdout; when it is missing (the
 * wrapper did not forward the flags) stdout is the fallback. A report that exists but cannot be
 * parsed fails closed rather than falling back to logs.
 */
export function parseCheckOutput(
  parser: CheckParser,
  run: {
    code: number;
    stdout: string;
    stderr: string;
    report?: { text: string } | { error: string } | undefined;
  },
  roots: readonly string[] = [],
): Failures {
  if (run.code === 0) return [];
  if (parser === "exit-code") return null;
  const fromFile = run.report && "text" in run.report && parser !== "tsc";
  const raw = fromFile ? (run.report as { text: string }).text : `${run.stdout}\n${run.stderr}`;
  if (raw.length > (fromFile ? MAX_REPORT_BYTES : MAX_PARSE_BYTES)) return null;
  const found = PARSE[parser](raw.replace(/\r\n?/g, "\n"), roots);
  if (!found || found.length === 0) return null;
  return found;
}
