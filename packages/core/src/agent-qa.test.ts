import { expect, test } from "vitest";
import {
  agentQaDeviceRecord,
  agentQaHeading,
  agentQaInputs,
  deviceOutcomeFromRecord,
  effectiveVerdict,
  infraFailure,
  infraFailureAll,
  latestAgentQaReport,
  parseAgentQaReport,
  priorAgentQaVerdict,
  renderAgentQaReport,
  rerunCommentPending,
  standingAgentQaVerdict,
} from "./agent-qa.js";

const SHA = "a".repeat(40);
const step = { action: "Tap", expected: "x", actual: "x", ok: true, criterion: 1 };

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
  expect(effectiveVerdict({ ...base, verdict: "PASS", steps: [step] }, 1).verdict).toBe("PASS");
  expect(effectiveVerdict({ ...base, verdict: "PASS", steps: [] }).verdict).toBe("BLOCKED");
  expect(
    effectiveVerdict({ ...base, verdict: "PASS", steps: [{ ...step, ok: false }] }).verdict,
  ).toBe("FAIL");
  expect(
    effectiveVerdict({
      verdict: "PASS",
      summary: "",
      steps: [step],
      findings: [
        {
          severity: "P2",
          title: "t",
          steps: "",
          expected: "",
          actual: "",
          cause: "pr",
          causeCheck: "",
        },
      ],
    }).verdict,
  ).toBe("FAIL");
  expect(
    effectiveVerdict(
      {
        verdict: "PASS",
        summary: "",
        steps: [step],
        findings: [
          {
            severity: "P3",
            title: "t",
            steps: "",
            expected: "",
            actual: "",
            cause: "pr",
            causeCheck: "",
          },
        ],
      },
      1,
    ).verdict,
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
  const body = `Matrix agent QA FAIL for ${SHA} (QA run run-1) (draft PR)`;
  expect(priorAgentQaVerdict([{ body, byMatrix: true }], SHA, "run-1")).toBe("FAIL");
  expect(priorAgentQaVerdict([{ body, byMatrix: false }], SHA, "run-1")).toBeUndefined();
  expect(priorAgentQaVerdict([{ body, byMatrix: true }], SHA, "run-2")).toBeUndefined();
  expect(priorAgentQaVerdict([{ body, byMatrix: true }], "b".repeat(40), "run-1")).toBeUndefined();
});

test("a marked comment by someone else, or a short SHA, is not a prior verdict", () => {
  const body = `Matrix agent QA PASS for ${SHA} (QA run run-1) (draft PR)`;
  // Linear app mode: `byMatrix` trusts the marker, `authoredByMatrix` the author.
  expect(
    priorAgentQaVerdict([{ body, byMatrix: true, authoredByMatrix: false }], SHA, "run-1"),
  ).toBeUndefined();
  expect(
    priorAgentQaVerdict([{ body, byMatrix: true, authoredByMatrix: true }], SHA, "run-1"),
  ).toBe("PASS");
  const short = `Matrix agent QA PASS for ${SHA.slice(0, 12)} (QA run run-1) (draft PR)`;
  expect(priorAgentQaVerdict([{ body: short, byMatrix: true }], SHA, "run-1")).toBeUndefined();
});

test("PASS needs a checked step per acceptance criterion", () => {
  const r = { verdict: "PASS" as const, summary: "", findings: [], steps: [step] };
  expect(effectiveVerdict(r, 1).verdict).toBe("PASS");
  expect(effectiveVerdict(r, 2).verdict).toBe("BLOCKED");
  expect(effectiveVerdict({ ...r, steps: [{ ...step, criterion: undefined }] }).verdict).toBe(
    "BLOCKED",
  );
});

test("two steps on criterion 1 do not cover criterion 2", () => {
  const r = { verdict: "PASS" as const, summary: "", findings: [], steps: [step, step] };
  expect(effectiveVerdict(r, 2)).toMatchObject({
    verdict: "BLOCKED",
    note: expect.stringContaining("2"),
  });
  expect(
    parseAgentQaReport(JSON.stringify({ ...r, steps: [{ ...step, criterion: true }] }))?.steps[0]
      ?.criterion,
  ).toBeUndefined();
});

test("with collected shots, a criterion needs a passing step whose screenshot was collected", () => {
  const r = {
    verdict: "PASS" as const,
    summary: "",
    findings: [],
    steps: [{ ...step, screenshot: "s1.png" }],
  };
  expect(effectiveVerdict(r, 1, new Set(["s1.png"])).verdict).toBe("PASS");
  expect(effectiveVerdict(r, 1, new Set()).verdict).toBe("BLOCKED");
  expect(effectiveVerdict({ ...r, steps: [step] }, 1, new Set(["s1.png"])).verdict).toBe("BLOCKED");
});

test("a ticket without acceptance criteria never passes on one checked step", () => {
  const r = { verdict: "PASS" as const, summary: "", findings: [], steps: [step] };
  expect(effectiveVerdict(r, 0)).toMatchObject({
    verdict: "BLOCKED",
    note: expect.stringContaining("no acceptance criteria"),
  });
  // A defect found without criteria still fails.
  expect(effectiveVerdict({ ...r, steps: [{ ...step, ok: false }] }, 0).verdict).toBe("FAIL");
});

test("the heading carries the inputs fingerprint; older headings without one still parse", () => {
  const inputs = agentQaInputs("## Root cause\n\nx", ["a", "b"]);
  expect(inputs).toMatch(/^[a-f0-9]{12}$/);
  expect(agentQaInputs("## Root cause\n\nx\r\n", ["a", "b"])).toBe(inputs);
  expect(agentQaInputs("## Root cause\n\ny", ["a", "b"])).not.toBe(inputs);
  expect(agentQaInputs("## Root cause\n\nx", ["a"])).not.toBe(inputs);
  const now = `${agentQaHeading("PASS", SHA, "run-1", inputs)} (draft PR)`;
  const old = `Matrix agent QA FAIL for ${SHA} (QA run run-1) (draft PR)`;
  expect(latestAgentQaReport([{ body: old, byMatrix: true }], SHA, "run-1")).toEqual({
    verdict: "FAIL",
  });
  // The newest report wins.
  expect(
    latestAgentQaReport(
      [
        { body: old, byMatrix: true },
        { body: now, byMatrix: true },
      ],
      SHA,
      "run-1",
    ),
  ).toEqual({ verdict: "PASS", inputs });
  expect(agentQaHeading("PASS", SHA, "run-1", "not-hex")).not.toContain("inputs");
});

test("/qa rerun counts only from a person, after Matrix's latest report", () => {
  const report = { body: `Matrix agent QA PASS for ${SHA} (QA run r)`, byMatrix: true };
  const ask = { body: "/qa rerun", byMatrix: false, author: "valentin" };
  expect(rerunCommentPending([report, ask])).toBe(true);
  expect(rerunCommentPending([ask, report])).toBe(false);
  expect(rerunCommentPending([report, { body: "/qa rerun", byMatrix: false }])).toBe(false);
  expect(rerunCommentPending([report, { body: "/qa rerun", byMatrix: true }])).toBe(false);
  expect(rerunCommentPending([report, { ...ask, body: "please /qa rerun" }])).toBe(false);
  expect(rerunCommentPending([report, { ...ask, body: "  /QA  rerun now" }])).toBe(true);
});

test("a device record round-trips for its head only and rejects tampered data", () => {
  const outcome = {
    kind: "report" as const,
    report: {
      verdict: "PASS" as const,
      summary: "ok",
      steps: [{ ...step, screenshot: "s1.png" }],
      findings: [],
    },
    screenshots: [{ name: "s1.png", bytes: new Uint8Array([1]) }],
    device: { serial: "emu" },
    build: { appId: "com.x", kind: "release" },
    durationMs: 60_000,
  };
  const record = JSON.parse(
    JSON.stringify(
      agentQaDeviceRecord(outcome, SHA, new Map([["s1.png", "https://u/s1.png"]]), [
        "Tap Export opens the share sheet",
        "Root cause written in the PR description",
      ]),
    ),
  );
  const back = deviceOutcomeFromRecord(record, SHA);
  expect(back?.outcome.screenshots.map((s) => s.name)).toEqual(["s1.png"]);
  expect(back?.outcome.report.steps[0]?.criterion).toBe(1);
  expect(back?.images.get("s1.png")).toBe("https://u/s1.png");
  expect(deviceOutcomeFromRecord(record, "b".repeat(40))).toBeUndefined();
  expect(deviceOutcomeFromRecord({ ...record, provenance: "x" }, SHA)).toBeUndefined();
  // A changed GitHub criterion keeps the device evidence; a changed or moved device one does not.
  const device = "Tap Export opens the share sheet";
  const github = "Root cause in the PR description, with a log";
  expect(deviceOutcomeFromRecord(record, SHA, [device, github])).toBeDefined();
  expect(
    deviceOutcomeFromRecord(record, SHA, ["Tap Share opens the sheet", github]),
  ).toBeUndefined();
  expect(deviceOutcomeFromRecord(record, SHA, [github, device])).toBeUndefined();
});

test("infra failures are told apart from real BLOCKED reasons", () => {
  const npm =
    "build failed: npm error llama.rn: getaddrinfo EAI\\_AGAIN release-assets.githubusercontent.com";
  expect(infraFailure(npm)).toBe("dns");
  expect(
    infraFailure("dial tcp: lookup api.anthropic.com on 127.0.0.11:53: read udp: i/o timeout"),
  ).toBe("dns");
  expect(infraFailure("build failed: npm error code ECONNRESET")).toBe("network");
  expect(infraFailure("build failed: npm error code E503 Service Unavailable")).toBe("registry");
  expect(infraFailure("build failed: ENOSPC: no space left on device, write")).toBe("disk");
  expect(infraFailure("device unavailable: emulator-5554 offline")).toBe("device");
  expect(infraFailure("device host unreachable over SSH: Connection closed")).toBe("device");
  expect(infraFailure("build failed:")).toBe("interrupted");
  expect(infraFailure("build failed: ")).toBe("interrupted");
  // Real causes stay BLOCKED.
  expect(infraFailure("build failed: error TS2304: Cannot find name 'foo'")).toBeUndefined();
  expect(infraFailure("the QA agent's report.json is invalid")).toBeUndefined();
  expect(infraFailure("device lane busy (held by another tenant)")).toBeUndefined();
  expect(infraFailure("the acceptance criteria are empty")).toBeUndefined();
});

test("an infra BLOCKED never replaces the PASS/FAIL before it for the same inputs", () => {
  const inputs = "dfeea545a54f";
  const head = (v: string, i = inputs) =>
    `Matrix agent QA ${v} for ${SHA} (QA run run-1, inputs ${i}) (draft PR)`;
  const blocked = (reason: string, i = inputs) => ({
    body: `${head("BLOCKED", i)}\n\nDevice: x\n\nThe agent QA lane could not test this change: ${reason}\n\nNothing passed.`,
    byMatrix: true,
  });
  const pass = { body: `${head("PASS")}\n\nall good`, byMatrix: true };
  const dns = blocked("build failed: npm error getaddrinfo EAI\\_AGAIN registry.npmjs.org");
  expect(standingAgentQaVerdict([pass, dns], SHA, "run-1")).toEqual({
    verdict: "PASS",
    inputs,
    infra: "dns",
  });
  // Several infra failures in a row still fall back to the PASS.
  expect(standingAgentQaVerdict([pass, dns, blocked("build failed:")], SHA, "run-1")?.verdict).toBe(
    "PASS",
  );
  // A real BLOCKED in between stands; so does a newest real BLOCKED.
  const real = blocked("no acceptance criteria");
  expect(standingAgentQaVerdict([pass, real, dns], SHA, "run-1")).toBeUndefined();
  expect(standingAgentQaVerdict([pass, real], SHA, "run-1")).toBeUndefined();
  // Changed inputs: the old PASS no longer speaks for them.
  expect(
    standingAgentQaVerdict(
      [pass, blocked("getaddrinfo EAI_AGAIN x", "000000000000")],
      SHA,
      "run-1",
    ),
  ).toBeUndefined();
  // Forged reports from a person never count.
  expect(standingAgentQaVerdict([{ ...pass, byMatrix: false }, dns], SHA, "run-1")).toBeUndefined();
  // Another head or QA run is not this verdict.
  expect(standingAgentQaVerdict([pass, dns], "b".repeat(40), "run-1")).toBeUndefined();
});

test("gateway drops are infra; a per-surface BLOCKED is infra only when every surface is", () => {
  expect(infraFailure("QA agent failed: ... API Error: Connection closed mid-response")).toBe(
    "gateway",
  );
  expect(infraFailure("API Error: Request rejected (429) · All credentials for model")).toBe(
    "gateway",
  );
  expect(
    infraFailureAll("Android: QA agent failed: API Error: Connection closed mid-response"),
  ).toBe("gateway");
  expect(
    infraFailureAll(
      "Android: the QA agent did not check acceptance criteria 3, 6 with a collected screenshot; iOS: QA agent failed: API Error: Request rejected (429)",
    ),
  ).toBeUndefined();
  // A product blocker that mentions rate limits is not the gateway.
  expect(
    infraFailureAll("Android: could not verify the rate limit acceptance criterion"),
  ).toBeUndefined();
  const head = (v: string) =>
    `Matrix agent QA ${v} for ${SHA} (QA run run-1, inputs dfeea545a54f) (draft PR)`;
  const pass = { body: `${head("PASS")}\n\nok`, byMatrix: true };
  const surface = {
    body: `${head("BLOCKED")}\n\nSummary: Android BLOCKED, iOS PASS.\n\nBlocked: Android: QA agent failed: API Error: Connection closed mid-response\n\n### Acceptance criteria`,
    byMatrix: true,
  };
  expect(standingAgentQaVerdict([pass, surface], SHA, "run-1")?.verdict).toBe("PASS");
});
