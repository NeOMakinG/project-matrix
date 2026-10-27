import type { AgentQaOutcome, AgentQaPort, AgentQaReport, AgentQaRequest } from "@matrix/core";
import { renderAgentQaReport } from "@matrix/core";
import { describe, expect, it } from "vitest";
import { combineOutcomes, MultiSurfaceAgentQaLane } from "./agent-qa-surfaces.js";
import { summarizeEvents } from "./web-qa-lane.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function reportOutcome(verdict: "PASS" | "FAIL", ok = verdict === "PASS"): AgentQaOutcome {
  const report: AgentQaReport = {
    verdict,
    summary: `${verdict} summary`,
    steps: [
      {
        action: "open picker",
        expected: "opens",
        actual: ok ? "opens" : "crash",
        ok,
        criterion: 1,
        screenshot: "s1.png",
      },
    ],
    findings: ok
      ? []
      : [
          {
            severity: "P1",
            title: "crash",
            steps: "",
            expected: "",
            actual: "",
            cause: "pr" as const,
            causeCheck: "",
            screenshot: undefined,
          },
        ],
  };
  return {
    kind: "report",
    report,
    screenshots: [{ name: "s1.png", bytes: PNG }],
    device: { serial: "x", model: "Phone" },
    build: { appId: "app", kind: "release" },
    durationMs: 60_000,
  };
}

const verdictOf = (o: AgentQaOutcome) =>
  renderAgentQaReport(o, {
    headSha: "a".repeat(40),
    qaRun: "r1",
    pullRequestUrl: "x",
    images: new Map(),
    criteriaCount: 1,
  }).verdict;

describe("combineOutcomes", () => {
  it("PASS only when every surface passes", () => {
    const o = combineOutcomes(
      [
        { surface: "android", outcome: reportOutcome("PASS") },
        { surface: "ios", outcome: reportOutcome("PASS") },
      ],
      1,
    );
    expect(verdictOf(o)).toBe("PASS");
    if (o.kind === "report")
      expect(o.screenshots.map((s) => s.name)).toEqual(["android-s1.png", "ios-s1.png"]);
  });

  it("one FAIL fails the whole report, a blocked surface shows as failed step", () => {
    const o = combineOutcomes(
      [
        { surface: "android", outcome: reportOutcome("FAIL") },
        { surface: "ios", outcome: { kind: "blocked", reason: "simulator unavailable" } },
      ],
      1,
    );
    expect(verdictOf(o)).toBe("FAIL");
    if (o.kind === "report")
      expect(o.report.steps.some((s) => /iOS: simulator unavailable/.test(s.action))).toBe(true);
  });

  it("PASS beside BLOCKED is BLOCKED, never PASS", () => {
    const o = combineOutcomes(
      [
        { surface: "android", outcome: reportOutcome("PASS") },
        { surface: "ios", outcome: { kind: "blocked", reason: "build failed" } },
      ],
      1,
    );
    expect(verdictOf(o)).toBe("BLOCKED");
  });

  it("a surface missing its criterion screenshot cannot ride on the other's", () => {
    const noShot = reportOutcome("PASS");
    if (noShot.kind === "report") noShot.screenshots = [];
    const o = combineOutcomes(
      [
        { surface: "android", outcome: reportOutcome("PASS") },
        { surface: "ios", outcome: noShot },
      ],
      1,
    );
    expect(verdictOf(o)).toBe("BLOCKED");
  });

  it("judges each surface on the device criteria only", () => {
    const o = combineOutcomes(
      [
        { surface: "android", outcome: reportOutcome("PASS") },
        { surface: "ios", outcome: reportOutcome("PASS") },
      ],
      2,
      [1],
    );
    expect(o.kind === "report" && o.report.verdict).toBe("PASS");
  });

  it("all blocked joins the reasons", () => {
    const o = combineOutcomes(
      [
        { surface: "android", outcome: { kind: "blocked", reason: "a" } },
        { surface: "web", outcome: { kind: "blocked", reason: "b" } },
      ],
      1,
    );
    expect(o).toEqual({ kind: "blocked", reason: "Android: a; Web: b" });
  });
});

describe("not tested steps", () => {
  it("never make a FAIL and keep a partly tested criterion from passing", () => {
    const o = reportOutcome("PASS");
    if (o.kind !== "report") return;
    o.report.steps.push({
      action: "long-press reorder",
      expected: "reorders",
      actual: "tool has no drag",
      ok: false,
      notTested: "tooling",
      criterion: 1,
      screenshot: "s1.png",
    });
    expect(verdictOf(o)).toBe("BLOCKED");
  });
});

describe("MultiSurfaceAgentQaLane", () => {
  it("runs one driver per surface and blocks a surface without a driver", async () => {
    const seen: string[] = [];
    const android: AgentQaPort = {
      handles: () => true,
      run: async (r) => {
        seen.push(r.surfaces.join());
        return reportOutcome("PASS");
      },
    };
    const lane = new MultiSurfaceAgentQaLane({ android });
    const out = await lane.run({
      surfaces: ["android", "ios"],
      criteria: ["c"],
      project: { id: "p" },
    } as unknown as AgentQaRequest);
    expect(seen).toEqual(["android"]);
    expect(verdictOf(out)).toBe("BLOCKED");
  });
});

describe("summarizeEvents", () => {
  it("dedupes and counts", () => {
    const line = (kind: string, text: string) => JSON.stringify({ kind, text });
    expect(
      summarizeEvents(
        [
          line("console", "error boom"),
          line("console", "error boom"),
          line("http", "404 GET /x"),
          "{bad",
        ].join("\n"),
      ),
    ).toEqual(["console: error boom (x2)", "http: 404 GET /x"]);
  });
});
