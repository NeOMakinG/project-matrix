import { expect, test } from "vitest";
import {
  type AgentQaReport,
  agentQaReportSchema,
  effectiveVerdict,
  renderAgentQaReport,
} from "./agent-qa.js";
import { classifyCriteria, type PullRequestFacts, verifyCodeCriteria } from "./qa-criteria.js";

// NEO-8's criteria, verbatim.
const NEO8 = [
  "Root cause identified and written in the PR description, with proof (log, trace or failing test).",
  "After tapping any thumbnail, all thumbnails in view keep showing their photo; only the selection highlight moves.",
  "Holds when selecting a thumbnail beyond the first render window and after scrolling the strip.",
  "Drag-to-reorder, strip scroll lock and cleanup on unmount still behave as today.",
  "Regression test reproducing the disappearance (fails before, passes after).",
  "Typecheck, lint and existing tests pass.",
];
const HEAD = "5003134ef6f2752d888043725c02d6ff4c2be4c9";

const facts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  headSha: HEAD,
  body: "## Summary\n\nFix\n\n## Root cause\n\nThe strip re-keyed every tile on selection, so `StoryPhotoTile` remounted and dropped its image; DaySheetScreen.strip.test.tsx fails before the fix.\n",
  files: [
    { path: "app/src/screens/DaySheetScreen.tsx", status: "modified", additions: 2 },
    { path: "app/src/screens/DaySheetScreen.strip.test.tsx", status: "added", additions: 228 },
  ],
  checks: [
    { name: "test", state: "success" },
    { name: "deploy/netlify", state: "failure" },
  ],
  baseFailing: ["deploy/netlify"],
  ...over,
});

const ok = { ok: true, summary: "checks passed: 0 new failures" };

test("splits NEO-8's criteria into device and GitHub ones", () => {
  expect(classifyCriteria(NEO8)).toEqual([
    "github",
    "device",
    "device",
    "device",
    "github",
    "github",
  ]);
  expect(
    classifyCriteria(["The film plays after tapping Play", "Tests are added for the parser"]),
  ).toEqual(["device", "github"]);
});

test("verifies root cause, regression test and CI from GitHub facts", () => {
  expect(verifyCodeCriteria(NEO8, [1, 5, 6], facts(), HEAD, ok).map((r) => r.status)).toEqual([
    "pass",
    "pass",
    "pass",
  ]);
  const bad = verifyCodeCriteria(
    NEO8,
    [1, 5, 6],
    facts({
      body: "## Summary\n\nFix day details",
      files: [{ path: "app/src/screens/DaySheetScreen.tsx", status: "modified", additions: 2 }],
      checks: [{ name: "lint", state: "failure" }],
    }),
    HEAD,
    ok,
  );
  expect(bad.map((r) => r.status)).toEqual(["fail", "fail", "fail"]);
  expect(bad[0]?.detail).toMatch(/no root cause/);
  expect(bad[2]?.detail).toMatch(/lint/);
});

test("a check failing on the base branch too is pre-existing; pending or a moved head is unverified", () => {
  const [ci] = verifyCodeCriteria(NEO8, [6], facts(), HEAD, ok);
  expect(ci?.status).toBe("pass");
  expect(ci?.detail).toMatch(/pre-existing\): deploy\/netlify/);
  expect(
    verifyCodeCriteria(
      NEO8,
      [6],
      facts({ checks: [{ name: "ci", state: "pending" }] }),
      HEAD,
      ok,
    )[0]?.status,
  ).toBe("unverified");
  expect(
    verifyCodeCriteria(NEO8, [6], facts({ headSha: "a".repeat(40) }), HEAD, ok)[0]?.status,
  ).toBe("unverified");
  expect(verifyCodeCriteria(NEO8, [6], undefined, HEAD, ok)[0]?.status).toBe("unverified");
  expect(
    verifyCodeCriteria(NEO8, [6], facts(), HEAD, { ok: false, summary: "2 new failures" })[0]
      ?.status,
  ).toBe("fail");
});

const step = (criterion: number, extra: Record<string, unknown> = {}) => ({
  action: `check ${criterion}`,
  expected: "e",
  actual: "a",
  ok: true,
  criterion,
  screenshot: `s${criterion}.png`,
  ...extra,
});
const shots = new Set(["s2.png", "s3.png", "s4.png"]);
const report = (raw: Record<string, unknown>): AgentQaReport =>
  agentQaReportSchema.parse({ summary: "", ...raw });
const passCode = verifyCodeCriteria(NEO8, [1, 5, 6], facts(), HEAD, ok);

test("NEO-8 shape: unreachable code criteria and a tooling limit no longer fail the run", () => {
  const r = report({
    verdict: "FAIL",
    steps: [
      step(2),
      step(3),
      step(4, { ok: false, notTested: "tooling", actual: "no hold-and-drag gesture" }),
      step(1, { ok: false, actual: "not verifiable from the device" }),
      step(5, { ok: false }),
      step(6, { ok: false }),
    ],
    findings: [
      {
        severity: "P2",
        title: "Photos 1, 4 and 7 render blank",
        cause: "environment",
        causeCheck:
          "the same three photos are blank in the trip tiles and the full-screen viewer, untouched by this PR",
      },
    ],
  });
  expect(effectiveVerdict(r, 6, shots, passCode).verdict).toBe("PASS");
  // A false code criterion is a real FAIL.
  const noRootCause = verifyCodeCriteria(NEO8, [1, 5, 6], facts({ body: "Fix" }), HEAD, ok);
  expect(effectiveVerdict(r, 6, shots, noRootCause)).toMatchObject({ verdict: "FAIL" });
  // Unverifiable on GitHub: BLOCKED, never PASS.
  expect(
    effectiveVerdict(r, 6, shots, verifyCodeCriteria(NEO8, [1, 5, 6], undefined, HEAD)).verdict,
  ).toBe("BLOCKED");
});

test("FAIL needs an observed defect; a pre-existing claim needs a check", () => {
  const failing = report({ verdict: "PASS", steps: [step(2), step(3, { ok: false }), step(4)] });
  expect(effectiveVerdict(failing, 6, shots, passCode).verdict).toBe("FAIL");
  const unchecked = report({
    verdict: "PASS",
    steps: [step(2), step(3), step(4)],
    findings: [{ severity: "P2", title: "blank tiles", cause: "pre_existing" }],
  });
  expect(effectiveVerdict(unchecked, 6, shots, passCode).verdict).toBe("FAIL");
  // Everything not tested: nothing passed on the device.
  const nothing = report({
    verdict: "PASS",
    steps: [2, 3, 4].map((n) => step(n, { ok: false, notTested: "tooling" })),
  });
  expect(effectiveVerdict(nothing, 6, shots, passCode).verdict).toBe("BLOCKED");
  // A device criterion without any step: BLOCKED.
  expect(
    effectiveVerdict(report({ verdict: "PASS", steps: [step(2), step(3)] }), 6, shots, passCode)
      .verdict,
  ).toBe("BLOCKED");
  // The agent's BLOCKED stands.
  expect(
    effectiveVerdict(report({ verdict: "BLOCKED", steps: [step(2)] }), 6, shots, passCode).verdict,
  ).toBe("BLOCKED");
});

test("the report lists every criterion with its source, and pre-existing findings apart", () => {
  const r = report({
    verdict: "PASS",
    steps: [step(2), step(3), step(4, { ok: false, notTested: "tooling" })],
    findings: [
      {
        severity: "P2",
        title: "Blank seeded photos",
        cause: "environment",
        causeCheck: "the same photos are blank on main's build of the app too",
      },
    ],
  });
  const { verdict, body } = renderAgentQaReport(
    {
      kind: "report",
      report: r,
      screenshots: [...shots].map((name) => ({ name, bytes: new Uint8Array() })),
      device: { serial: "emulator-5554" },
      build: { appId: "a.b", kind: "release" },
      durationMs: 60_000,
    },
    {
      headSha: HEAD,
      qaRun: "run-1",
      pullRequestUrl: "https://github.com/o/r/pull/1",
      images: new Map(),
      criteriaCount: 6,
      code: passCode,
      criteria: NEO8,
      filed: new Map([[0, "NEO-99"]]),
    },
  );
  expect(verdict).toBe("PASS");
  expect(body).toMatch(/- #1 PASS \(github\)/);
  expect(body).toMatch(/- #4 NOT TESTED \(tooling\) \(device\)/);
  expect(body).toMatch(/3\. NOT TESTED \(tooling\) \(acceptance #4\)/);
  expect(body).toMatch(
    /### Pre-existing \/ environment[^\n]*\n+- P2 Blank seeded photos.*Filed as NEO-99/,
  );
  expect(body).not.toMatch(/### Findings/);
});

test("a compound criterion goes to both sides; a test edit without a new case is not a regression test", () => {
  expect(
    classifyCriteria(["Regression test covers export, and tapping Export opens the share sheet"]),
  ).toEqual(["both"]);
  const commentOnly = facts({
    files: [
      { path: "app/src/screens/DaySheetScreen.tsx", status: "modified", additions: 2 },
      {
        path: "app/src/screens/DaySheetScreen.test.tsx",
        status: "modified",
        additions: 1,
        patch: '@@ -1,2 +1,3 @@\n+// covers the strip\n test("old", () => {});',
      },
    ],
  });
  expect(verifyCodeCriteria(NEO8, [5], commentOnly, HEAD, ok)[0]?.status).toBe("fail");
  const elsewhere = facts({
    files: [
      { path: "app/src/screens/DaySheetScreen.tsx", status: "modified", additions: 2 },
      {
        path: "e2e/flows/strip.test.ts",
        status: "added",
        additions: 30,
        patch: '+test("strip", () => {});',
      },
    ],
  });
  expect(verifyCodeCriteria(NEO8, [5], elsewhere, HEAD, ok)[0]?.status).toBe("unverified");
});

test("both halves of a compound criterion must hold, and a P1 is never excused as pre-existing", () => {
  const criteria = ["Regression test covers export, and tapping Export opens the share sheet"];
  const code = verifyCodeCriteria(criteria, [1], facts({ files: [] }), HEAD, ok).map((r) => ({
    ...r,
    alsoDevice: true,
  }));
  const r = report({ verdict: "PASS", steps: [step(1, { screenshot: "s2.png" })] });
  expect(effectiveVerdict(r, 1, shots, code).verdict).toBe("FAIL");
  const crash = report({
    verdict: "PASS",
    steps: [step(2), step(3), step(4)],
    findings: [
      {
        severity: "P1",
        title: "crash on open",
        cause: "pre_existing",
        causeCheck: "it also crashes on the main branch build, before this PR existed",
      },
    ],
  });
  expect(effectiveVerdict(crash, 6, shots, passCode).verdict).toBe("FAIL");
});
