import { createHash } from "node:crypto";
import { z } from "zod";
import { type CodeCriterionResult, classifyCriteria } from "./qa-criteria.js";
import type { ProjectConfig, QaSurface } from "./types.js";

export const QA_PASSED_LABEL = "qa:passed";
export const QA_FAILED_LABEL = "qa:failed";
export const AGENT_QA_MARKER = "Matrix agent QA";
/** A human asks for a fresh agent QA run on the same head; Matrix removes it when the run starts. */
export const QA_RERUN_LABEL = "qa:rerun";
/** Provenance of the receipt that keeps a device result for a later GitHub-only re-evaluation. */
export const AGENT_QA_DEVICE_PROVENANCE = "matrix:agent-qa-device:v1";

/** BLOCKED reason when the ticket lists no acceptance criteria (the PR checklist is empty). */
export const NO_CRITERIA =
  "no acceptance criteria: the ticket lists none, so the PR checklist is empty; add an Acceptance criteria list to the ticket";

export type AgentQaVerdict = "PASS" | "FAIL" | "BLOCKED";

const text = (max: number) =>
  z
    .string()
    .max(20_000)
    .transform((s) => clean(s, max));

const shotName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.png$/)
  .optional()
  .catch(undefined);

/** The QA agent's `report.json` (untrusted: bounded, sanitized, never trusted for a pass alone). */
export const agentQaReportSchema = z.object({
  verdict: z.enum(["PASS", "FAIL", "BLOCKED"]),
  summary: text(600),
  blockedReason: text(300).optional(),
  steps: z
    .array(
      z.object({
        action: text(300),
        expected: text(300).default(""),
        actual: text(300).default(""),
        ok: z.boolean(),
        /** 1-based number of the acceptance criterion this step checks; false/absent: none. */
        criterion: z
          .union([z.boolean(), z.number().int().min(1).max(30)])
          .default(false)
          .transform((c) => (typeof c === "number" ? c : undefined)),
        screenshot: shotName,
        /** Set when the step could not be exercised: a tooling limit (no such gesture in the
         * driver) or the environment. A not-tested step is neither a pass nor a failure. */
        notTested: z.enum(["tooling", "environment"]).optional().catch(undefined),
      }),
    )
    .max(40)
    .default([]),
  findings: z
    .array(
      z.object({
        severity: z.enum(["P1", "P2", "P3"]),
        title: text(200),
        steps: text(600).default(""),
        expected: text(300).default(""),
        actual: text(300).default(""),
        screenshot: shotName,
        /** "pre_existing" / "environment": not caused by this PR, with the check that shows it. */
        cause: z.enum(["pr", "pre_existing", "environment"]).default("pr").catch("pr"),
        causeCheck: text(300).default(""),
      }),
    )
    .max(20)
    .default([]),
});

type Finding = AgentQaReport["findings"][number];

/** A finding counts against the PR unless the agent says why it is not the PR's and how it checked. */
export function isPreExisting(f: Finding): boolean {
  // A P1 (crash, data loss, broken main flow) always stops the PR, whoever caused it.
  return f.severity !== "P1" && f.cause !== "pr" && f.causeCheck.replace(/\s+/g, " ").length >= 40;
}

export type AgentQaReport = z.output<typeof agentQaReportSchema>;

export interface AgentQaDevice {
  serial: string;
  model?: string;
  android?: string;
  /** Any other OS/runtime line ("iOS 18.2", "Chrome 141, 1280x800"); shown instead of Android. */
  os?: string;
}

export interface AgentQaBuild {
  appId: string;
  version?: string;
  abi?: string;
  kind: string;
}

export interface AgentQaScreenshot {
  name: string;
  bytes: Uint8Array;
}

/** What the lane returns: a report, or the reason the app could not be tested. */
export type AgentQaOutcome =
  | {
      kind: "report";
      report: AgentQaReport;
      screenshots: AgentQaScreenshot[];
      device: AgentQaDevice;
      build: AgentQaBuild;
      durationMs: number;
      /** Lane-collected evidence lines (console errors, failed requests), untrusted text. */
      evidence?: string[];
    }
  | { kind: "blocked"; reason: string; device?: AgentQaDevice; build?: AgentQaBuild };

export interface AgentQaRequest {
  project: ProjectConfig;
  ticket: { id: string; title: string; body: string; comments: string[] };
  pullRequest: { url: string; number: number; repo: string };
  headSha: string;
  surfaces: QaSurface[];
  criteria: string[];
  /** 1-based numbers of the criteria the device agent checks (the rest Matrix checks on GitHub).
   * Absent: all of them. */
  deviceCriteria?: number[];
  /** The PR description, context for the agent (untrusted). */
  pullRequestBody?: string;
  signal: AbortSignal;
}

/**
 * Host-side agent QA lane: builds the draft PR at `headSha`, installs it on a device and lets a QA
 * agent test it. Single tenant: implementations queue jobs and never run two at once.
 */
export interface AgentQaPort {
  /** False for projects the lane has no build settings for (they block with a reason). */
  handles(project: ProjectConfig): boolean;
  run(request: AgentQaRequest): Promise<AgentQaOutcome>;
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064]/g;

function clean(s: string, max: number): string {
  const out = s.replace(CONTROL, "").replace(/\r/g, "").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** One line of untrusted text, safe inside markdown (no headings, links, images, HTML or mentions). */
function md(s: string, max = 300): string {
  return clean(s, max)
    .replace(/\s*\n\s*/g, " ")
    .replace(/[\\`*_[\]<>!#|~@]/g, (c) => `\\${c}`);
}

export function parseAgentQaReport(raw: string): AgentQaReport | undefined {
  try {
    const parsed = agentQaReportSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The verdict Matrix acts on. A PASS is kept only when no step failed and no P1/P2 finding exists;
 * a FAIL needs at least one failed step or finding (otherwise the agent could not show a defect:
 * BLOCKED). Nothing here ever upgrades a report to PASS.
 */
export function effectiveVerdict(
  report: AgentQaReport,
  criteriaCount = 0,
  /** Screenshot files the lane actually collected; when given, a criterion counts as checked only
   * by a passing step whose screenshot is among them (evidence, not just the agent's word). */
  shots?: ReadonlySet<string>,
  /** Code/CI criteria Matrix verified itself; when given, the device agent only had the others. */
  code?: readonly CodeCriterionResult[],
): { verdict: AgentQaVerdict; note?: string } {
  if (code) return splitVerdict(report, criteriaCount, shots, code);
  // A step the agent could not run (tooling/environment) is no defect: it never makes a FAIL, and
  // the criterion it belongs to is not covered (a PASS cannot stand on an untested part).
  const failedSteps = report.steps.filter((s) => !s.ok && !s.notTested).length;
  const untested = new Set(
    report.steps.flatMap((s) => (s.notTested && s.criterion ? [s.criterion] : [])),
  );
  const serious = report.findings.filter((f) => f.severity !== "P3").length;
  if (report.verdict === "PASS") {
    if (!report.steps.length)
      return { verdict: "BLOCKED", note: "the QA agent reported PASS without any checked step" };
    // Nothing to check against: one passing step proves nothing about the change.
    if (criteriaCount < 1 && !failedSteps && !serious)
      return { verdict: "BLOCKED", note: NO_CRITERIA };
    // Every acceptance criterion needs its own passing step (by number), not just any N steps.
    const evidenced = (s: AgentQaReport["steps"][number]) =>
      !shots || (s.screenshot !== undefined && shots.has(s.screenshot));
    const covered = new Set(
      report.steps.flatMap((s) => (s.criterion && s.ok && evidenced(s) ? [s.criterion] : [])),
    );
    const missing = Array.from({ length: criteriaCount }, (_, i) => i + 1).filter(
      (n) => !covered.has(n) || untested.has(n),
    );
    if (!failedSteps && !serious && missing.length)
      return {
        verdict: "BLOCKED",
        note: `the QA agent did not fully check acceptance criteria ${missing.join(", ")} with a collected screenshot`,
      };
    if (failedSteps || serious)
      return {
        verdict: "FAIL",
        note: "the QA agent reported PASS with failed steps or P1/P2 findings",
      };
    return { verdict: "PASS" };
  }
  if (report.verdict === "FAIL" && !failedSteps && !report.findings.length)
    return {
      verdict: "BLOCKED",
      note: "the QA agent reported FAIL without a failed step or finding",
    };
  return { verdict: report.verdict };
}

export type CriterionStatus =
  | "PASS"
  | "FAIL"
  | "NOT TESTED (tooling)"
  | "NOT TESTED"
  | "NOT VERIFIED"
  /** A step says it passed but its screenshot was not collected: no evidence, so it blocks. */
  | "PASS WITHOUT SCREENSHOT";

export interface CriterionLine {
  criterion: number;
  source: "device" | "github" | "both";
  status: CriterionStatus;
  detail?: string;
}

/** One line per acceptance criterion: its status and who verified it. */
export function criterionLines(
  report: AgentQaReport,
  criteriaCount: number,
  shots: ReadonlySet<string> | undefined,
  code: readonly CodeCriterionResult[],
): CriterionLine[] {
  const byCode = new Map(code.map((c) => [c.criterion, c]));
  return Array.from({ length: criteriaCount }, (_, i): CriterionLine => {
    const n = i + 1;
    const c = byCode.get(n);
    const onGithub: CriterionStatus | undefined = c
      ? c.status === "pass"
        ? "PASS"
        : c.status === "fail"
          ? "FAIL"
          : "NOT VERIFIED"
      : undefined;
    if (c && onGithub && !c.alsoDevice)
      return { criterion: n, source: "github", status: onGithub, detail: c.detail };
    const steps = report.steps.filter((s) => s.criterion === n);
    const status: CriterionStatus = steps.some((s) => !s.ok && !s.notTested)
      ? "FAIL"
      : steps.some(
            (s) =>
              s.ok &&
              !s.notTested &&
              (!shots || (s.screenshot !== undefined && shots.has(s.screenshot))),
          )
        ? "PASS"
        : steps.some((s) => s.ok && !s.notTested)
          ? "PASS WITHOUT SCREENSHOT"
          : steps.some((s) => s.notTested === "tooling")
            ? "NOT TESTED (tooling)"
            : "NOT TESTED";
    if (!c || !onGithub) return { criterion: n, source: "device", status };
    // Both halves must hold: a failure on either side fails it, an unverified code half blocks it.
    const both: CriterionStatus =
      status === "FAIL" || onGithub === "FAIL"
        ? "FAIL"
        : onGithub === "NOT VERIFIED"
          ? "NOT VERIFIED"
          : status;
    return { criterion: n, source: "both", status: both, detail: c.detail };
  });
}

/**
 * Verdict when the criteria were split: FAIL needs an observed product defect (a failed device
 * step, or a P1/P2 finding the PR caused) or a code/CI criterion that is false. A criterion the
 * driver cannot exercise is NOT TESTED (tooling), listed but not a failure. PASS needs every
 * code/CI criterion verified, at least one device criterion passed with a collected screenshot and
 * every other device criterion passed or not testable by the tooling; anything short of that is
 * BLOCKED. The agent's own FAIL does not stand without a defect (it cannot see GitHub, and earlier
 * agents failed what they could not reach), but its BLOCKED always stands.
 */
function splitVerdict(
  report: AgentQaReport,
  criteriaCount: number,
  shots: ReadonlySet<string> | undefined,
  code: readonly CodeCriterionResult[],
): { verdict: AgentQaVerdict; note?: string } {
  if (report.verdict === "BLOCKED") return { verdict: "BLOCKED" };
  const codeNumbers = new Set(code.filter((c) => !c.alsoDevice).map((c) => c.criterion));
  const deviceSteps = report.steps.filter((s) => !s.criterion || !codeNumbers.has(s.criterion));
  const failed = deviceSteps.filter((s) => !s.ok && !s.notTested).length;
  const serious = report.findings.filter((f) => f.severity !== "P3" && !isPreExisting(f)).length;
  const excused = report.findings.filter((f) => f.severity === "P2" && isPreExisting(f)).length;
  const codeFailed = code.filter((c) => c.status === "fail").map((c) => c.criterion);
  if (failed || serious || codeFailed.length)
    return {
      verdict: "FAIL",
      ...(codeFailed.length && !failed && !serious
        ? { note: `code/CI acceptance criteria ${codeFailed.join(", ")} are not met on GitHub` }
        : {}),
    };
  if (criteriaCount < 1) return { verdict: "BLOCKED", note: NO_CRITERIA };
  const lines = criterionLines(report, criteriaCount, shots, code);
  const device = lines.filter((l) => l.source !== "github");
  const unverified = lines.filter((l) => l.status === "NOT VERIFIED").map((l) => l.criterion);
  if (unverified.length)
    return {
      verdict: "BLOCKED",
      note: `Matrix could not verify code/CI acceptance criteria ${unverified.join(", ")} on GitHub`,
    };
  const unchecked = device
    .filter((l) => l.status === "NOT TESTED" || l.status === "PASS WITHOUT SCREENSHOT")
    .map((l) => l.criterion);
  if (unchecked.length)
    return {
      verdict: "BLOCKED",
      note: `the QA agent did not check acceptance criteria ${unchecked.join(", ")} with a collected screenshot`,
    };
  if (device.length && !device.some((l) => l.status === "PASS"))
    return { verdict: "BLOCKED", note: "no device acceptance criterion could be tested" };
  const notes = [
    ...(report.verdict === "PASS"
      ? []
      : [
          "the QA agent reported FAIL, but no device step failed, no finding is caused by this PR and every code/CI criterion holds",
        ]),
    ...(excused
      ? [
          `${excused} P2 finding(s) counted as pre-existing / environment on the agent's check: review them below`,
        ]
      : []),
  ];
  return notes.length ? { verdict: "PASS", note: notes.join("; ") } : { verdict: "PASS" };
}

/** Title prefix of the tracker issues Matrix files for pre-existing findings (dedupe key). */
export const PRE_EXISTING_PREFIX = "QA pre-existing:";

/** The tracker issue for a pre-existing finding: escaped agent text, plus where it was seen. */
export function preExistingIssue(
  f: Finding,
  ctx: { ticketId: string; pullRequestUrl: string; headSha: string },
): { title: string; body: string } {
  const title = `${PRE_EXISTING_PREFIX} ${clean(f.title.replace(/\s+/g, " "), 160)}`;
  return {
    title,
    body: [
      `Matrix agent QA saw this while testing ${md(ctx.ticketId, 40)} (${md(ctx.pullRequestUrl, 200)} at \`${ctx.headSha.slice(0, 12)}\`), and judged it not caused by that PR.`,
      `Severity: ${f.severity} · Cause: ${f.cause === "environment" ? "environment" : "pre-existing"}`,
      `Check: ${md(f.causeCheck, 300)}`,
      `Steps: ${md(f.steps, 600) || "n/a"}`,
      `Expected: ${md(f.expected) || "n/a"}`,
      `Actual: ${md(f.actual) || "n/a"}`,
    ].join("\n\n"),
  };
}

/** Same issue for dedupe: case, spacing and punctuation do not matter. */
export function sameIssueTitle(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return norm(a) === norm(b);
}

/**
 * `qaRun` ties the report to one QA run: a loop back that changes nothing gets a fresh run.
 * `inputs` fingerprints what the GitHub-checked criteria were judged on (PR description and
 * acceptance criteria); a later change to either re-evaluates them (see `agentQaInputs`).
 */
export function agentQaHeading(
  verdict: AgentQaVerdict,
  headSha: string,
  qaRun: string,
  inputs?: string,
): string {
  const tag = inputs && /^[a-f0-9]{12}$/.test(inputs) ? `, inputs ${inputs}` : "";
  return `${AGENT_QA_MARKER} ${verdict} for ${headSha} (QA run ${runTag(qaRun)}${tag})`;
}

function runTag(qaRun: string): string {
  return qaRun.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12) || "unknown";
}

/** Fingerprint of a verdict's non-code inputs: the PR description and the acceptance criteria. */
export function agentQaInputs(pullRequestBody: string, criteria: readonly string[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify([pullRequestBody.replace(/\r/g, "").trim(), criteria.map((c) => c.trim())]),
    )
    .digest("hex")
    .slice(0, 12);
}

type QaComment = { body: string; byMatrix: boolean; authoredByMatrix?: boolean; author?: string };

const HEADING_RE =
  /^Matrix agent QA (PASS|FAIL|BLOCKED) for ([a-f0-9]{40}) \(QA run ([A-Za-z0-9-]+)(?:, inputs ([a-f0-9]{12}))?\)/;

/** The newest report Matrix posted for this head and QA run, with the inputs it was judged on. */
export function latestAgentQaReport(
  comments: readonly QaComment[],
  headSha: string,
  qaRun: string,
): { verdict: AgentQaVerdict; inputs?: string } | undefined {
  let found: { verdict: AgentQaVerdict; inputs?: string } | undefined;
  for (const c of comments) {
    // A marker in the body is forgeable by any commenter: only Matrix's own comments count.
    if (!(c.authoredByMatrix ?? c.byMatrix)) continue;
    const m = c.body.match(HEADING_RE);
    // The full head SHA: a short prefix could be matched by a crafted commit.
    if (m && headSha === m[2] && m[3] === runTag(qaRun))
      found = { verdict: m[1] as AgentQaVerdict, ...(m[4] ? { inputs: m[4] } : {}) };
  }
  return found;
}

/**
 * Build/infra failures that say nothing about the change under test: DNS and network errors,
 * registry 5xx, a full disk, an offline device or device host, a build killed before it printed
 * anything. Returns the failure class, or undefined for a real BLOCKED (missing criteria, test
 * data, a report the agent could not write...). Markdown escapes from a posted report are undone.
 */
const INFRA_FAILURES: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "dns",
    /EAI_AGAIN|ENOTFOUND|getaddrinfo|Temporary failure in name resolution|Could not resolve host|no such host|lookup \S+ on \S+:\d+: |server misbehaving/i,
  ],
  [
    "network",
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|i\/o timeout|network (?:error|timeout|is unreachable)|Connection (?:timed out|reset by peer)|TLS handshake timeout|ERR_SOCKET_TIMEOUT|Could not (?:GET|HEAD|download) 'https?:/i,
  ],
  [
    "registry",
    /\bE50[0-4]\b|\b50[234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)|(?:status code|HTTP\/?\d?(?:\.\d)?) 50[0-4]\b/i,
  ],
  ["disk", /ENOSPC|No space left on device|disk (?:is )?full/i],
  [
    "gateway",
    /API Error: (?:Connection closed|Request rejected \(429\)|5\d\d\b|Overloaded)|All credentials for model|rate[ _-]?limit(?:ed)?\b|overloaded_error|\b429 Too Many Requests/i,
  ],
  [
    "device",
    /device unavailable|device (?:is )?offline|emulator (?:is )?offline|no devices\/emulators found|all automated Android devices unavailable|device host (?:unreachable|overloaded)/i,
  ],
  ["interrupted", /^(?:iOS |web )?build failed:?\s*$/i],
];

export function infraFailure(reason: string): string | undefined {
  const text = reason.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1").trim();
  for (const [kind, re] of INFRA_FAILURES) if (re.test(text)) return kind;
  return undefined;
}

const BLOCKED_REASON_RE = /^The agent QA lane could not test this change: ?(.*)$/m;
/** Per-surface reports put the reason on a `Blocked:` line (`Android: ...; iOS: ...`). */
const SURFACE_BLOCKED_RE = /^Blocked: ?(.*)$/m;

/**
 * Infra class of a BLOCKED reason when every surface that blocked did so on infra; a single real
 * cause on any surface (missing test data, an unchecked criterion) makes it a real BLOCKED.
 */
export function infraFailureAll(reason: string): string | undefined {
  const parts = reason.split(/;\s*(?=(?:Android|iOS|Web|web):)/);
  let kind: string | undefined;
  for (const part of parts) {
    const k = infraFailure(part.replace(/^(?:Android|iOS|Web|web):\s*/, ""));
    if (!k) return undefined;
    kind ??= k;
  }
  return kind;
}

/**
 * Matrix's agent QA reports for this head and QA run, oldest first, with the inputs each was
 * judged on and, for a BLOCKED, the reason it gave.
 */
export function agentQaReports(
  comments: readonly QaComment[],
  headSha: string,
  qaRun: string,
): { verdict: AgentQaVerdict; inputs?: string; reason?: string }[] {
  const out: { verdict: AgentQaVerdict; inputs?: string; reason?: string }[] = [];
  for (const c of comments) {
    if (!(c.authoredByMatrix ?? c.byMatrix)) continue;
    const m = c.body.match(HEADING_RE);
    if (!m || headSha !== m[2] || m[3] !== runTag(qaRun)) continue;
    const reason =
      m[1] === "BLOCKED"
        ? (c.body.match(BLOCKED_REASON_RE)?.[1] ?? c.body.match(SURFACE_BLOCKED_RE)?.[1])
        : undefined;
    out.push({
      verdict: m[1] as AgentQaVerdict,
      ...(m[4] ? { inputs: m[4] } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return out;
}

/**
 * The verdict that stands for this head and QA run once infra failures are set aside: a BLOCKED
 * caused by infrastructure (see `infraFailure`) never replaces the PASS or FAIL posted before it
 * for the same inputs. Returns that PASS/FAIL when the newest report is such an infra BLOCKED.
 */
export function standingAgentQaVerdict(
  comments: readonly QaComment[],
  headSha: string,
  qaRun: string,
): { verdict: "PASS" | "FAIL"; inputs?: string; infra: string } | undefined {
  const reports = agentQaReports(comments, headSha, qaRun);
  const newest = reports.at(-1);
  if (newest?.verdict !== "BLOCKED" || newest.reason === undefined) return undefined;
  const infra = infraFailureAll(newest.reason);
  if (!infra) return undefined;
  for (let i = reports.length - 2; i >= 0; i--) {
    const r = reports[i] as (typeof reports)[number];
    if (r.verdict === "BLOCKED") {
      // Another BLOCKED in between: an infra one is skipped, a real one stands.
      if (r.reason !== undefined && infraFailureAll(r.reason)) continue;
      return undefined;
    }
    if (r.inputs && newest.inputs && r.inputs !== newest.inputs) return undefined;
    return { verdict: r.verdict, ...(r.inputs ? { inputs: r.inputs } : {}), infra };
  }
  return undefined;
}

/** The verdict of an earlier report comment for this head and QA run, if Matrix posted one. */
export function priorAgentQaVerdict(
  comments: readonly QaComment[],
  headSha: string,
  qaRun: string,
): AgentQaVerdict | undefined {
  return latestAgentQaReport(comments, headSha, qaRun)?.verdict;
}

/**
 * True when a person (not Matrix, not an integration without a user) posted `/qa rerun` after
 * Matrix's newest agent QA report on the ticket. Commenting needs access to the tracker team, so
 * this is the owner or a team member.
 */
export function rerunCommentPending(comments: readonly QaComment[]): boolean {
  let pending = false;
  for (const c of comments) {
    if (c.authoredByMatrix ?? c.byMatrix) {
      if (c.body.startsWith(AGENT_QA_MARKER)) pending = false;
      continue;
    }
    if (!c.byMatrix && c.author && /^\s*\/qa\s+rerun\b/i.test(c.body)) pending = true;
  }
  return pending;
}

/** What a device run produced, kept so a description-only change re-uses it (no rebuild). */
export interface AgentQaDeviceRecord {
  provenance: typeof AGENT_QA_DEVICE_PROVENANCE;
  headSha: string;
  /** The acceptance criteria the device run was given (its steps cite them by number). */
  criteria: string[];
  report: AgentQaReport;
  screenshots: string[];
  /** Screenshot name -> uploaded asset URL. */
  images: Record<string, string>;
  device: AgentQaDevice;
  build: AgentQaBuild;
  durationMs: number;
}

export function agentQaDeviceRecord(
  outcome: Extract<AgentQaOutcome, { kind: "report" }>,
  headSha: string,
  images: ReadonlyMap<string, string>,
  criteria: readonly string[],
): AgentQaDeviceRecord {
  return {
    provenance: AGENT_QA_DEVICE_PROVENANCE,
    headSha,
    criteria: [...criteria],
    report: outcome.report,
    screenshots: outcome.screenshots.map((s) => s.name),
    images: Object.fromEntries(images),
    device: outcome.device,
    build: outcome.build,
    durationMs: outcome.durationMs,
  };
}

/** The criteria a device checks, with their numbers (what a stored device result vouches for). */
function deviceHalf(criteria: readonly string[]): string {
  const sources = classifyCriteria(criteria);
  return JSON.stringify(criteria.map((c, i) => (sources[i] === "github" ? null : c.trim())));
}

const recordSchema = z.object({
  provenance: z.literal(AGENT_QA_DEVICE_PROVENANCE),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  criteria: z.array(z.string().max(2_000)).max(60),
  report: agentQaReportSchema,
  screenshots: z.array(z.string().max(100)).max(40),
  images: z.record(z.string().max(100), z.string().max(2_000)),
  device: z.object({
    serial: z.string().max(100),
    model: z.string().max(100).optional(),
    android: z.string().max(40).optional(),
  }),
  build: z.object({
    appId: z.string().max(200),
    version: z.string().max(80).optional(),
    abi: z.string().max(40).optional(),
    kind: z.string().max(40),
  }),
  durationMs: z.number().nonnegative(),
});

/**
 * The device outcome a record holds for `headSha` (screenshots by name only), or undefined. With
 * `criteria`, also undefined when a criterion the device checks differs (text, number or count)
 * from those the record's run was given: its steps would vouch for a requirement nobody tested.
 */
export function deviceOutcomeFromRecord(
  data: unknown,
  headSha: string,
  criteria?: readonly string[],
):
  | { outcome: Extract<AgentQaOutcome, { kind: "report" }>; images: Map<string, string> }
  | undefined {
  const parsed = recordSchema.safeParse(data);
  if (!parsed.success || parsed.data.headSha !== headSha) return undefined;
  const r = parsed.data;
  if (criteria && deviceHalf(criteria) !== deviceHalf(r.criteria)) return undefined;
  return {
    outcome: {
      kind: "report",
      report: r.report,
      screenshots: r.screenshots.map((name) => ({ name, bytes: new Uint8Array() })),
      device: {
        serial: r.device.serial,
        ...(r.device.model ? { model: r.device.model } : {}),
        ...(r.device.android ? { android: r.device.android } : {}),
      },
      build: {
        appId: r.build.appId,
        kind: r.build.kind,
        ...(r.build.version ? { version: r.build.version } : {}),
        ...(r.build.abi ? { abi: r.build.abi } : {}),
      },
      durationMs: r.durationMs,
    },
    images: new Map(Object.entries(r.images)),
  };
}

export interface RenderedReport {
  verdict: AgentQaVerdict;
  body: string;
}

/**
 * The Linear comment. `images` maps screenshot names to uploaded asset URLs; names without an
 * upload are listed as text. Every agent-supplied string is escaped.
 */
export function renderAgentQaReport(
  outcome: AgentQaOutcome,
  ctx: {
    headSha: string;
    qaRun: string;
    /** `agentQaInputs` of the description and criteria the code/CI half was judged on. */
    inputs?: string;
    pullRequestUrl: string;
    images: ReadonlyMap<string, string>;
    /** Number of acceptance criteria the agent was asked to check. */
    criteriaCount?: number;
    /** Code/CI criteria Matrix verified on GitHub (the agent only had the other ones). */
    code?: readonly CodeCriterionResult[];
    /** The acceptance criteria, for the per-criterion list. */
    criteria?: readonly string[];
    /** Pre-existing findings filed as tracker issues: finding index -> issue id. */
    filed?: ReadonlyMap<number, string>;
  },
): RenderedReport {
  const prLink = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(ctx.pullRequestUrl)
    ? `[draft PR](${ctx.pullRequestUrl})`
    : "draft PR";
  const device = outcome.device
    ? `${md(outcome.device.model ?? outcome.device.serial, 160)}${outcome.device.os ? `, ${md(outcome.device.os, 80)}` : outcome.device.android ? `, Android ${md(outcome.device.android, 20)}` : ""}`
    : "n/a";
  const build = outcome.build
    ? `${md(outcome.build.appId, 80)}${outcome.build.version ? ` ${md(outcome.build.version, 40)}` : ""} (${md(outcome.build.kind, 30)}${outcome.build.abi ? `, ${md(outcome.build.abi, 20)}` : ""})`
    : "n/a";
  if (outcome.kind === "blocked") {
    return {
      verdict: "BLOCKED",
      body: [
        `${agentQaHeading("BLOCKED", ctx.headSha, ctx.qaRun, ctx.inputs)} (${prLink})`,
        `Device: ${device} · Build: ${build}`,
        `The agent QA lane could not test this change: ${md(outcome.reason, 400)}`,
        "Nothing passed. Fix the cause, then remove the `needs-human` label to re-run agent QA on the same commit (or test it yourself and approve the merge in Matrix).",
      ].join("\n\n"),
    };
  }
  const { report } = outcome;
  const { verdict, note } = effectiveVerdict(
    report,
    ctx.criteriaCount ?? 0,
    new Set(outcome.screenshots.map((s) => s.name)),
    ctx.code,
  );
  const image = (name: string | undefined) => {
    if (!name) return "";
    const url = ctx.images.get(name);
    return url && /^https:\/\/[^\s()<>]+$/.test(url)
      ? ` ![${md(name, 80)}](${url})`
      : ` (screenshot ${md(name, 80)})`;
  };
  const lines = [
    `${agentQaHeading(verdict, ctx.headSha, ctx.qaRun, ctx.inputs)} (${prLink})`,
    `Device: ${device} · Build: ${build} · ${Math.max(1, Math.round(outcome.durationMs / 60_000))} min`,
    `Summary: ${md(report.summary, 600)}`,
  ];
  if (note) lines.push(`Matrix note: ${note}.`);
  if (verdict === "BLOCKED" && report.blockedReason)
    lines.push(`Blocked: ${md(report.blockedReason, 300)}`);
  if (ctx.code) {
    lines.push("### Acceptance criteria");
    lines.push(
      criterionLines(
        report,
        ctx.criteriaCount ?? 0,
        new Set(outcome.screenshots.map((s) => s.name)),
        ctx.code,
      )
        .map((l) => {
          const text = ctx.criteria?.[l.criterion - 1];
          return `- #${l.criterion} ${l.status} (${l.source})${text ? `: ${md(text, 200)}` : ""}${l.detail ? ` (${md(l.detail, 300)})` : ""}`;
        })
        .join("\n"),
    );
  }
  if (report.steps.length) {
    lines.push("### Steps");
    lines.push(
      report.steps
        .map(
          (s, i) =>
            `${i + 1}. ${s.notTested ? `NOT TESTED (${s.notTested})` : s.ok ? "PASS" : "FAIL"}${s.criterion ? ` (acceptance #${s.criterion})` : ""}: ${md(s.action)}. Expected: ${md(s.expected) || "n/a"}. Actual: ${md(s.actual) || "n/a"}.${image(s.screenshot)}`,
        )
        .join("\n"),
    );
  }
  const finding = (f: Finding) =>
    `- ${f.severity} ${md(f.title, 200)}. Steps: ${md(f.steps, 600) || "n/a"}. Expected: ${md(f.expected) || "n/a"}. Actual: ${md(f.actual) || "n/a"}.${image(f.screenshot)}`;
  const own = report.findings.filter((f) => !ctx.code || !isPreExisting(f));
  if (own.length) {
    lines.push("### Findings");
    lines.push(own.map(finding).join("\n"));
  }
  const elsewhere = ctx.code
    ? report.findings.map((f, i) => [f, i] as const).filter(([f]) => isPreExisting(f))
    : [];
  if (elsewhere.length) {
    lines.push("### Pre-existing / environment (not caused by this PR, does not fail it)");
    lines.push(
      elsewhere
        .map(([f, i]) => {
          const id = ctx.filed?.get(i);
          return `${finding(f)} Cause: ${f.cause === "environment" ? "environment" : "pre-existing"}; check: ${md(f.causeCheck, 300)}.${id ? ` Filed as ${md(id, 40)}.` : ""}`;
        })
        .join("\n"),
    );
  }
  if (outcome.evidence?.length) {
    lines.push("### Lane evidence");
    lines.push(
      outcome.evidence
        .slice(0, 30)
        .map((e) => `- ${md(e, 300)}`)
        .join("\n"),
    );
  }
  lines.push(
    verdict === "PASS"
      ? "Merge stays with a human: review the draft PR, merge it on GitHub and approve the merge in Matrix."
      : verdict === "FAIL"
        ? "Matrix sends the ticket back to Implement with this report as input."
        : "Nothing passed. Remove the `needs-human` label to re-run agent QA on the same commit.",
  );
  return { verdict, body: lines.join("\n\n") };
}
