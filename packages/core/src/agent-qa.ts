import { z } from "zod";
import type { ProjectConfig, QaSurface } from "./types.js";

export const QA_PASSED_LABEL = "qa:passed";
export const QA_FAILED_LABEL = "qa:failed";
export const AGENT_QA_MARKER = "Matrix agent QA";

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
        criterion: z.boolean().default(false),
        screenshot: shotName,
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
      }),
    )
    .max(20)
    .default([]),
});

export type AgentQaReport = z.output<typeof agentQaReportSchema>;

export interface AgentQaDevice {
  serial: string;
  model?: string;
  android?: string;
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
    }
  | { kind: "blocked"; reason: string; device?: AgentQaDevice; build?: AgentQaBuild };

export interface AgentQaRequest {
  project: ProjectConfig;
  ticket: { id: string; title: string; body: string; comments: string[] };
  pullRequest: { url: string; number: number; repo: string };
  headSha: string;
  surfaces: QaSurface[];
  criteria: string[];
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
): { verdict: AgentQaVerdict; note?: string } {
  const failedSteps = report.steps.filter((s) => !s.ok).length;
  const serious = report.findings.filter((f) => f.severity !== "P3").length;
  if (report.verdict === "PASS") {
    if (!report.steps.length)
      return { verdict: "BLOCKED", note: "the QA agent reported PASS without any checked step" };
    const checked = report.steps.filter((s) => s.criterion).length;
    const wanted = Math.max(1, criteriaCount);
    if (!failedSteps && !serious && checked < wanted)
      return {
        verdict: "BLOCKED",
        note: `the QA agent checked ${checked} of ${wanted} acceptance criteria`,
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

/** `qaRun` ties the report to one QA run: a loop back that changes nothing gets a fresh run. */
export function agentQaHeading(verdict: AgentQaVerdict, headSha: string, qaRun: string): string {
  return `${AGENT_QA_MARKER} ${verdict} for ${headSha.slice(0, 12)} (QA run ${runTag(qaRun)})`;
}

function runTag(qaRun: string): string {
  return qaRun.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12) || "unknown";
}

/** The verdict of an earlier report comment for this head and QA run, if Matrix posted one. */
export function priorAgentQaVerdict(
  comments: readonly { body: string; byMatrix: boolean }[],
  headSha: string,
  qaRun: string,
): AgentQaVerdict | undefined {
  let found: AgentQaVerdict | undefined;
  for (const c of comments) {
    if (!c.byMatrix) continue;
    const m = c.body.match(
      /^Matrix agent QA (PASS|FAIL|BLOCKED) for ([a-f0-9]{7,40}) \(QA run ([A-Za-z0-9-]+)\)/,
    );
    if (m && headSha.startsWith(m[2] ?? "-") && m[3] === runTag(qaRun))
      found = m[1] as AgentQaVerdict;
  }
  return found;
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
    pullRequestUrl: string;
    images: ReadonlyMap<string, string>;
    /** Number of acceptance criteria the agent was asked to check. */
    criteriaCount?: number;
  },
): RenderedReport {
  const prLink = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(ctx.pullRequestUrl)
    ? `[draft PR](${ctx.pullRequestUrl})`
    : "draft PR";
  const device = outcome.device
    ? `${md(outcome.device.model ?? outcome.device.serial, 80)}${outcome.device.android ? `, Android ${md(outcome.device.android, 20)}` : ""}`
    : "n/a";
  const build = outcome.build
    ? `${md(outcome.build.appId, 80)}${outcome.build.version ? ` ${md(outcome.build.version, 40)}` : ""} (${md(outcome.build.kind, 30)}${outcome.build.abi ? `, ${md(outcome.build.abi, 20)}` : ""})`
    : "n/a";
  if (outcome.kind === "blocked") {
    return {
      verdict: "BLOCKED",
      body: [
        `${agentQaHeading("BLOCKED", ctx.headSha, ctx.qaRun)} (${prLink})`,
        `Device: ${device} · Build: ${build}`,
        `The agent QA lane could not test this change: ${md(outcome.reason, 400)}`,
        "Nothing passed. Fix the cause, then remove the `needs-human` label to re-run agent QA on the same commit (or test it yourself and approve the merge in Matrix).",
      ].join("\n\n"),
    };
  }
  const { report } = outcome;
  const { verdict, note } = effectiveVerdict(report, ctx.criteriaCount ?? 0);
  const image = (name: string | undefined) => {
    if (!name) return "";
    const url = ctx.images.get(name);
    return url && /^https:\/\/[^\s()<>]+$/.test(url)
      ? ` ![${md(name, 80)}](${url})`
      : ` (screenshot ${md(name, 80)})`;
  };
  const lines = [
    `${agentQaHeading(verdict, ctx.headSha, ctx.qaRun)} (${prLink})`,
    `Device: ${device} · Build: ${build} · ${Math.max(1, Math.round(outcome.durationMs / 60_000))} min`,
    `Summary: ${md(report.summary, 600)}`,
  ];
  if (note) lines.push(`Matrix note: ${note}.`);
  if (verdict === "BLOCKED" && report.blockedReason)
    lines.push(`Blocked: ${md(report.blockedReason, 300)}`);
  if (report.steps.length) {
    lines.push("### Steps");
    lines.push(
      report.steps
        .map(
          (s, i) =>
            `${i + 1}. ${s.ok ? "PASS" : "FAIL"}${s.criterion ? " (acceptance)" : ""}: ${md(s.action)}. Expected: ${md(s.expected) || "n/a"}. Actual: ${md(s.actual) || "n/a"}.${image(s.screenshot)}`,
        )
        .join("\n"),
    );
  }
  if (report.findings.length) {
    lines.push("### Findings");
    lines.push(
      report.findings
        .map(
          (f) =>
            `- ${f.severity} ${md(f.title, 200)}. Steps: ${md(f.steps, 600) || "n/a"}. Expected: ${md(f.expected) || "n/a"}. Actual: ${md(f.actual) || "n/a"}.${image(f.screenshot)}`,
        )
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
