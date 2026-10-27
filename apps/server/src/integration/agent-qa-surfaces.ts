import { readFileSync } from "node:fs";
import {
  type AgentQaOutcome,
  type AgentQaPort,
  type AgentQaReport,
  type AgentQaRequest,
  type AgentQaScreenshot,
  effectiveVerdict,
  type ProjectConfig,
  type QaSurface,
} from "@matrix/core";

import { laneConfigSchema, SshAgentQaLane } from "./agent-qa-lane.js";
import { iosLaneSchema, TapflowIosQaLane } from "./ios-qa-lane.js";
import { ChromeWebQaLane, webLaneSchema } from "./web-qa-lane.js";

/**
 * Lanes from `MATRIX_QA_LANE_CONFIG`: the top-level keys are the Android lane (unchanged format),
 * `ios` the tapflow simulator lane, `web` the Chrome lane. Each section is validated on its own.
 */
export function createSurfaceLanes(path: string, holder: string): MultiSurfaceAgentQaLane {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const drivers: Partial<Record<QaSurface, AgentQaPort>> = {};
  if (raw.host !== undefined)
    // One server per host: a restarted server owns (and releases) its predecessor's lock.
    drivers.android = new SshAgentQaLane(laneConfigSchema.parse(raw), {
      holder,
      reclaimOnStart: true,
    });
  if (raw.ios !== undefined)
    drivers.ios = new TapflowIosQaLane(iosLaneSchema.parse(raw.ios), { holder: `${holder}-ios` });
  if (raw.web !== undefined) drivers.web = new ChromeWebQaLane(webLaneSchema.parse(raw.web));
  return new MultiSurfaceAgentQaLane(drivers);
}

const NAMES: Record<string, string> = { android: "Android", ios: "iOS", web: "Web" };

/**
 * Routes one agent QA job to a driver per surface (android: adb lane, ios: tapflow lane,
 * web: Chrome lane) and merges the results. PASS needs every surface to pass: one FAIL makes the
 * merged report FAIL, otherwise one BLOCKED (or a surface without a driver) makes it BLOCKED.
 */
export class MultiSurfaceAgentQaLane implements AgentQaPort {
  constructor(private readonly drivers: Partial<Record<QaSurface, AgentQaPort>>) {}

  handles(project: ProjectConfig): boolean {
    return Object.values(this.drivers).some((d) => d?.handles(project));
  }

  async run(request: AgentQaRequest): Promise<AgentQaOutcome> {
    const surfaces: QaSurface[] = request.surfaces.length ? request.surfaces : ["android"];
    const results: { surface: QaSurface; outcome: AgentQaOutcome }[] = [];
    for (const surface of surfaces) {
      const driver = this.drivers[surface];
      const outcome: AgentQaOutcome = driver?.handles(request.project)
        ? await driver
            .run({ ...request, surfaces: [surface] })
            .catch((e: Error) => ({ kind: "blocked" as const, reason: e.message.slice(0, 300) }))
        : {
            kind: "blocked",
            reason: `no ${NAMES[surface] ?? surface} QA driver is configured for this project on the Matrix host`,
          };
      results.push({ surface, outcome });
    }
    return combineOutcomes(results, request.criteria.length, request.deviceCriteria);
  }
}

/** One outcome from per-surface outcomes; each surface is judged on its own criteria coverage. */
export function combineOutcomes(
  results: { surface: QaSurface; outcome: AgentQaOutcome }[],
  criteriaCount: number,
  /** Criteria the device agents check; the others Matrix verifies on GitHub (judged there). */
  deviceCriteria?: readonly number[],
): AgentQaOutcome {
  // Per-surface judgement covers the device criteria only: the rest stand in as checked here and
  // are judged once, by the reconciler, against Matrix's own GitHub verification (renderAgentQaReport
  // with the real code results). These placeholders only rank surfaces; they never reach a verdict.
  const others = deviceCriteria
    ? Array.from({ length: criteriaCount }, (_, i) => i + 1)
        .filter((n) => !deviceCriteria.includes(n))
        .map((criterion) => ({ criterion, status: "pass" as const, detail: "checked by Matrix" }))
    : undefined;
  const first = results[0];
  if (results.length === 1 && first) return first.outcome;
  const tag = (s: QaSurface) => NAMES[s] ?? s;
  if (results.every((r) => r.outcome.kind === "blocked"))
    return {
      kind: "blocked",
      reason: results
        .map((r) => `${tag(r.surface)}: ${r.outcome.kind === "blocked" ? r.outcome.reason : ""}`)
        .join("; ")
        .slice(0, 600),
    };
  const verdicts: string[] = [];
  const steps: AgentQaReport["steps"] = [];
  const findings: AgentQaReport["findings"] = [];
  const shots: AgentQaScreenshot[] = [];
  const evidence: string[] = [];
  const summaries: string[] = [];
  const devices: string[] = [];
  const builds: string[] = [];
  let durationMs = 0;
  let worst: "PASS" | "BLOCKED" | "FAIL" = "PASS";
  const blocked: string[] = [];
  for (const { surface, outcome } of results) {
    const t = tag(surface);
    const d = outcome.device;
    if (d)
      devices.push(
        `${t}: ${d.model ?? d.serial}${d.os ? ` ${d.os}` : d.android ? ` Android ${d.android}` : ""}`,
      );
    if (outcome.build)
      builds.push(
        `${t}: ${outcome.build.appId}${outcome.build.version ? ` ${outcome.build.version}` : ""} (${outcome.build.kind})`,
      );
    if (outcome.kind === "blocked") {
      blocked.push(`${t}: ${outcome.reason}`);
      verdicts.push(`${t} BLOCKED`);
      if (worst === "PASS") worst = "BLOCKED";
      continue;
    }
    const prefix = `${surface}-`;
    const rename = (n: string | undefined) => (n ? `${prefix}${n}`.slice(0, 85) : undefined);
    const names = new Set(outcome.screenshots.map((s) => s.name));
    const own = effectiveVerdict(outcome.report, criteriaCount, names, others);
    verdicts.push(`${t} ${own.verdict}`);
    if (own.verdict === "FAIL") worst = "FAIL";
    else if (own.verdict === "BLOCKED") {
      if (worst === "PASS") worst = "BLOCKED";
      blocked.push(`${t}: ${own.note ?? outcome.report.blockedReason ?? "blocked"}`);
    }
    summaries.push(`${t}: ${outcome.report.summary}`);
    // Each surface keeps its share of the 40-step report, failures and criterion checks first,
    // so one long report never pushes another surface's evidence out.
    const share = Math.max(1, Math.floor(40 / results.length));
    // Failures first, then the first evidenced passing step of each criterion, then the rest.
    const firstOk = new Set<number>();
    const rank = (x: (typeof outcome.report.steps)[number], i: number) => {
      if (!x.ok) return 0;
      if (x.criterion && x.screenshot && !firstOk.has(x.criterion)) {
        firstOk.add(x.criterion);
        return 1;
      }
      return 2 + i / 1000;
    };
    const ranked = outcome.report.steps.map((x, i) => ({ x, r: rank(x, i) }));
    for (const { x: s } of ranked.sort((a, b) => a.r - b.r).slice(0, share))
      steps.push({ ...s, action: `[${t}] ${s.action}`, screenshot: rename(s.screenshot) });
    for (const f of outcome.report.findings)
      findings.push({ ...f, title: `[${t}] ${f.title}`, screenshot: rename(f.screenshot) });
    for (const s of outcome.screenshots)
      shots.push({ name: rename(s.name) ?? s.name, bytes: s.bytes });
    for (const e of outcome.evidence ?? []) evidence.push(`${t}: ${e}`);
    durationMs += outcome.durationMs;
  }
  // A blocked surface next to a FAIL still shows as a failed step: nothing about it passed.
  if (worst === "FAIL")
    for (const b of blocked)
      steps.push({
        action: `${b}`,
        expected: "the surface is tested",
        actual: "BLOCKED",
        ok: false,
        criterion: undefined,
        screenshot: undefined,
      });
  const report: AgentQaReport = {
    verdict: worst,
    summary: `${verdicts.join(", ")}. ${summaries.join(" ")}`.slice(0, 600),
    ...(worst === "BLOCKED" ? { blockedReason: blocked.join("; ").slice(0, 300) } : {}),
    steps: steps.slice(0, 40),
    findings: findings.slice(0, 20),
  };
  return {
    kind: "report",
    report,
    screenshots: shots.slice(0, 36),
    device: { serial: "multi", model: devices.join(" · ").slice(0, 160) || "n/a" },
    build: { appId: builds.join(" · ").slice(0, 80) || "n/a", kind: "per surface" },
    durationMs,
    ...(evidence.length ? { evidence } : {}),
  };
}
