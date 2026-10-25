import { expect, test } from "vitest";
import {
  effectiveVerdict,
  parseAgentQaReport,
  priorAgentQaVerdict,
  renderAgentQaReport,
} from "./agent-qa.js";

const SHA = "a".repeat(40);
const step = { action: "Tap", expected: "x", actual: "x", ok: true, criterion: true };

test("parses and bounds the agent report; rejects garbage", () => {
  expect(parseAgentQaReport("not json")).toBeUndefined();
  expect(parseAgentQaReport(JSON.stringify({ verdict: "MAYBE", summary: "" }))).toBeUndefined();
  const r = parseAgentQaReport(
    JSON.stringify({
      verdict: "PASS",
      summary: `ok\u200b${"y".repeat(5000)}`,
      steps: [{ ...step, screenshot: "../etc/passwd.png" }],
    }),
  );
  expect(r?.summary.length).toBeLessThanOrEqual(600);
  expect(r?.summary).not.toContain("\u200b");
  expect(r?.steps[0]?.screenshot).toBeUndefined();
});

test("never upgrades to PASS; inconsistent reports are downgraded", () => {
  const base = { summary: "", findings: [] };
  expect(effectiveVerdict({ ...base, verdict: "PASS", steps: [step] }).verdict).toBe("PASS");
  expect(effectiveVerdict({ ...base, verdict: "PASS", steps: [] }).verdict).toBe("BLOCKED");
  expect(
    effectiveVerdict({ ...base, verdict: "PASS", steps: [{ ...step, ok: false }] }).verdict,
  ).toBe("FAIL");
  expect(
    effectiveVerdict({
      verdict: "PASS",
      summary: "",
      steps: [step],
      findings: [{ severity: "P2", title: "t", steps: "", expected: "", actual: "" }],
    }).verdict,
  ).toBe("FAIL");
  expect(
    effectiveVerdict({
      verdict: "PASS",
      summary: "",
      steps: [step],
      findings: [{ severity: "P3", title: "t", steps: "", expected: "", actual: "" }],
    }).verdict,
  ).toBe("PASS");
  expect(effectiveVerdict({ ...base, verdict: "FAIL", steps: [step] }).verdict).toBe("BLOCKED");
});

test("agent text cannot inject links, images, headings or mentions", () => {
  const { body } = renderAgentQaReport(
    {
      kind: "report",
      report: {
        verdict: "PASS",
        summary: "# done ![x](https://evil.example/p.png) [click](https://evil.example) @valentin",
        steps: [step],
        findings: [],
      },
      screenshots: [],
      device: { serial: "s" },
      build: { appId: "a", kind: "release" },
      durationMs: 1,
    },
    { headSha: SHA, qaRun: "run-1", pullRequestUrl: "javascript:alert(1)", images: new Map() },
  );
  expect(body).not.toMatch(/[^\\]\]\(https:\/\/evil/);
  expect(body).toContain("\\[click\\](https://evil");
  expect(body).not.toContain("\n# done");
  expect(body).toContain("\\@valentin");
  expect(body).not.toContain("javascript:");
});

test("prior verdicts are matched per head and QA run, Matrix comments only", () => {
  const body = `Matrix agent QA FAIL for ${SHA.slice(0, 12)} (QA run run-1) (draft PR)`;
  expect(priorAgentQaVerdict([{ body, byMatrix: true }], SHA, "run-1")).toBe("FAIL");
  expect(priorAgentQaVerdict([{ body, byMatrix: false }], SHA, "run-1")).toBeUndefined();
  expect(priorAgentQaVerdict([{ body, byMatrix: true }], SHA, "run-2")).toBeUndefined();
  expect(priorAgentQaVerdict([{ body, byMatrix: true }], "b".repeat(40), "run-1")).toBeUndefined();
});
