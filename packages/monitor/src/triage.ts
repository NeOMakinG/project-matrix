import { createHash } from "node:crypto";
import { z } from "zod";
import type { Issue } from "./group.js";
import { extractJson } from "./llm.js";
import type { Deployment, GraphHint, GraphPort, LlmClient } from "./ports.js";

export type Severity = "critical" | "high" | "medium" | "low";

export const FixAssessment = z.object({
  fixable: z.number().min(0).max(1),
  category: z.enum(["code", "config", "infra", "third_party", "data", "unknown"]),
  rootCause: z.string().min(1).max(1200),
  rationale: z.string().min(1).max(1200),
  suspectedFiles: z.array(z.string()).max(10),
  reproSteps: z.array(z.string()).max(10),
});
export type FixAssessment = z.infer<typeof FixAssessment>;

export interface Regression {
  regression: boolean;
  release?: string;
  reason: string;
}

export interface Impact {
  users: number;
  occurrences: number;
  perHour: number;
  environments: string[];
}

export interface Triage {
  fingerprint: string;
  severity: Severity;
  impact: Impact;
  regression: Regression;
  hints: GraphHint[];
  assessment: FixAssessment;
  model: string;
  promptVersion: string;
  promptHash: string;
  at: string;
}

const HOUR = 3_600_000;

export function impactOf(issue: Issue, now: string): Impact {
  const spanH = Math.max(1, (Date.parse(now) - Date.parse(issue.firstSeen)) / HOUR);
  return {
    users: issue.users,
    occurrences: issue.count,
    perHour: Number((issue.count / spanH).toFixed(3)),
    environments: issue.environments,
  };
}

/**
 * A regression is an issue that reappeared after being resolved, or whose first occurrence
 * comes after the latest deploy of a release it shows up in, with no occurrences in earlier releases.
 */
export function detectRegression(issue: Issue, deployments: Deployment[]): Regression {
  if (issue.status === "reopened") {
    const r: Regression = { regression: true, reason: "recurred after being resolved" };
    if (issue.fixRelease) r.release = issue.fixRelease;
    return r;
  }
  const sorted = [...deployments].sort(
    (a, b) => Date.parse(a.deployedAt) - Date.parse(b.deployedAt),
  );
  const seenReleases = Object.keys(issue.releases);
  if (sorted.length === 0 || seenReleases.length === 0) {
    return { regression: false, reason: "no release data" };
  }
  const firstSeen = Date.parse(issue.firstSeen);
  const introducing = [...sorted].reverse().find((d) => Date.parse(d.deployedAt) <= firstSeen);
  if (!introducing) return { regression: false, reason: "first seen before any known deploy" };
  const earlier = sorted
    .filter((d) => Date.parse(d.deployedAt) < Date.parse(introducing.deployedAt))
    .map((d) => d.release);
  const seenEarlier = seenReleases.some((r) => earlier.includes(r));
  const inIntroducing = seenReleases.includes(introducing.release);
  if (inIntroducing && !seenEarlier && earlier.length > 0) {
    return {
      regression: true,
      release: introducing.release,
      reason: `first seen after deploying ${introducing.release}, never in earlier releases`,
    };
  }
  return { regression: false, reason: "also present in earlier releases" };
}

export function severityOf(issue: Issue, impact: Impact, regression: Regression): Severity {
  if (issue.kind === "downtime" || issue.level === "fatal") return "critical";
  let score = issue.level === "error" ? 2 : issue.level === "warning" ? 1 : 0;
  if (impact.users >= 100) score += 2;
  else if (impact.users >= 10) score += 1;
  if (impact.perHour >= 50) score += 2;
  else if (impact.perHour >= 5) score += 1;
  if (regression.regression) score += 1;
  if (score >= 5) return "critical";
  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

export const TRIAGE_PROMPT_VERSION = "triage-v1";

const SYSTEM = `You are the production triage step of a software factory.
Given one grouped production issue, decide how likely an automated coding agent can fix it in the codebase without human input.
Answer with ONE JSON object and nothing else, matching:
{"fixable": number 0..1, "category": "code"|"config"|"infra"|"third_party"|"data"|"unknown", "rootCause": string, "rationale": string, "suspectedFiles": string[], "reproSteps": string[]}
Rules: base everything on the evidence given; do not invent files that are not in the frames or hints; fixable is high only for code bugs with a clear location; third-party outages, infra and data corruption score low. Keep rootCause and rationale under 4 sentences each.`;

/** Deterministic: sorted keys, no wall-clock values, bounded sizes. */
export function triagePrompt(
  issue: Issue,
  impact: Impact,
  regression: Regression,
  hints: GraphHint[],
) {
  const evidence = {
    title: issue.title,
    message: issue.message.slice(0, 500),
    kind: issue.kind,
    level: issue.level,
    exceptionType: issue.exceptionType ?? null,
    frames: issue.frames.slice(0, 12).map((f) => ({
      file: f.file,
      function: f.function ?? null,
      line: f.line ?? null,
      inApp: f.inApp,
    })),
    impact: {
      users: impact.users,
      occurrences: impact.occurrences,
      perHour: impact.perHour,
      environments: [...impact.environments].sort(),
    },
    regression,
    releases: Object.keys(issue.releases).sort(),
    providers: [...issue.providers].sort(),
    codeGraphHints: hints.map((h) => ({
      path: h.path,
      symbol: h.symbol ?? null,
      reason: h.reason,
      adrs: [...h.adrs].sort(),
      features: [...h.features].sort(),
    })),
  };
  const user = `Issue evidence:\n${JSON.stringify(evidence, null, 2)}`;
  const promptHash = createHash("sha256").update(SYSTEM).update(user).digest("hex").slice(0, 16);
  return { system: SYSTEM, user, promptHash };
}

export interface TriageDeps {
  llm: LlmClient;
  graph: GraphPort;
  model: string;
  deployments: Deployment[];
  now: string;
}

export async function triage(issue: Issue, deps: TriageDeps): Promise<Triage> {
  const impact = impactOf(issue, deps.now);
  const regression = detectRegression(issue, deps.deployments);
  const hintInput: Parameters<GraphPort["hintsFor"]>[0] = {
    projectId: issue.projectId,
    frames: issue.frames,
    title: issue.title,
  };
  if (issue.exceptionType) hintInput.exceptionType = issue.exceptionType;
  const hints = await deps.graph.hintsFor(hintInput);
  const prompt = triagePrompt(issue, impact, regression, hints);

  let assessment: FixAssessment | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2 && !assessment; attempt++) {
    try {
      const text = await deps.llm.complete({
        model: deps.model,
        system: prompt.system,
        user:
          attempt === 0
            ? prompt.user
            : `${prompt.user}\n\nYour previous answer was not valid JSON for the schema. Return only the JSON object.`,
        maxTokens: 4000,
      });
      assessment = FixAssessment.parse(extractJson(text));
    } catch (e) {
      lastError = e;
    }
  }
  if (!assessment) {
    assessment = {
      fixable: 0,
      category: "unknown",
      rootCause: "Automated triage failed; needs a human.",
      rationale: `LLM triage unavailable: ${String(lastError).slice(0, 200)}`,
      suspectedFiles: hints.map((h) => h.path).slice(0, 5),
      reproSteps: [],
    };
  }
  const known = new Set([...hints.map((h) => h.path), ...issue.frames.map((f) => f.file)]);
  assessment.suspectedFiles = assessment.suspectedFiles.filter((f) => known.has(f));

  return {
    fingerprint: issue.fingerprint,
    severity: severityOf(issue, impact, regression),
    impact,
    regression,
    hints,
    assessment,
    model: deps.model,
    promptVersion: TRIAGE_PROMPT_VERSION,
    promptHash: prompt.promptHash,
    at: deps.now,
  };
}
