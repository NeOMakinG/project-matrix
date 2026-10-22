import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  HoldoutStore,
  holdoutReceipt,
  parseScenarios,
  parseVerdicts,
  privateQaCause,
  retryPrivateQa,
} from "./holdout.js";
import { parseFindings, pickReviewer, reviewReceipt } from "./review.js";
import { testProject } from "./testing/fakes.js";

describe("model output parsing", () => {
  test.each([
    "returns 5 and produces no observable I/O",
    "same sum and no side effects",
    "works correctly",
    "state remains unchanged",
  ])("rejects uninstrumentable or unobservable claim: %s", (then) => {
    expect(() =>
      parseScenarios(JSON.stringify([{ given: "2,3", when: "add called repeatedly", then }])),
    ).toThrow();
  });

  test("accepts instrumented absence checks and rejects malformed fields and duplicate ids", () => {
    const scenario = {
      id: "s4",
      given: "stub fs/net/console before import",
      when: "add(2,3) called repeatedly",
      then: "every call returns 5 and assert zero intercepted fs/net/console calls",
    };
    expect(parseScenarios(JSON.stringify([scenario]))).toEqual([scenario]);
    expect(() => parseScenarios(JSON.stringify([{ ...scenario, then: 5 }]))).toThrow();
    expect(() => parseScenarios(JSON.stringify([scenario, scenario]))).toThrow();
  });

  test("positive I/O requirements are not treated as absence claims", () => {
    const scenario = {
      given: "a temp directory",
      when: "save(5) is called",
      then: "writes the result to a file via I/O and the file contains 5",
    };
    expect(parseScenarios(JSON.stringify([scenario]))).toHaveLength(1);
  });

  test("retry is bounded and cancellation never retries", async () => {
    let calls = 0;
    await expect(
      retryPrivateQa(new AbortController().signal, async () => {
        calls++;
        throw new Error("private");
      }),
    ).rejects.toThrow();
    expect(calls).toBe(2);
    const controller = new AbortController();
    calls = 0;
    await expect(
      retryPrivateQa(controller.signal, async () => {
        calls++;
        controller.abort();
        throw new Error("private");
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  test("findings tolerate prose and code fences", () => {
    const text =
      'Here is my review:\n```json\n{"findings":[{"severity":"P1","title":"SQL injection","file":"api.ts:9"}]}\n```';
    expect(parseFindings(text)).toEqual([
      { severity: "P1", title: "SQL injection", file: "api.ts:9" },
    ]);
  });

  test("invalid severities are rejected", () => {
    expect(() => parseFindings('{"findings":[{"severity":"P0","title":"x"}]}')).toThrow();
    expect(() => parseFindings("no json here")).toThrow();
  });

  test("review receipt fails only on P1", () => {
    expect(reviewReceipt("performance", "m", [{ severity: "P2", title: "a" }]).ok).toBe(true);
    expect(reviewReceipt("performance", "m", [{ severity: "P1", title: "a" }]).ok).toBe(false);
  });

  test("scenario ids are sanitised and verdicts scored", () => {
    const scenarios = parseScenarios(
      '[{"id":"../evil","given":"g","when":"w","then":"t"},{"given":"g","when":"w","then":"t"}]',
    );
    expect(scenarios.map((s) => s.id)).toEqual(["s1", "s2"]);
    const verdicts = parseVerdicts(
      '{"verdicts":[{"id":"s1","satisfied":true},{"id":"s2","satisfied":false}]}',
    );
    expect(holdoutReceipt(scenarios, verdicts, "judge").data).toMatchObject({ satisfaction: 0.5 });
  });
});

describe("reviewer selection", () => {
  test("never picks the implementer's model", () => {
    const cfg = testProject();
    expect(pickReviewer(cfg, "fable-5-1").model).toBe("gpt-6.1-sol");
    expect(pickReviewer(cfg, "gpt-6.1-sol").model).toBe("glm-5.3");
  });

  test("never falls back to the configured implementer model (P2)", () => {
    const cfg = testProject({
      models: {
        implement: { runner: "claude-code", model: "fable-5-1" },
        review: { runner: "claude-code", model: "fable-5-1" },
      },
      reviewerFallbacks: [],
    });
    expect(() => pickReviewer(cfg, undefined)).toThrow("no reviewer model differs");
  });

  test("throws when no different model is available", () => {
    const cfg = testProject({ reviewerFallbacks: [] });
    expect(() => pickReviewer(cfg, "gpt-6.1-sol")).toThrow();
  });
});

describe("holdout store", () => {
  test("isInside is not fooled by a shared prefix (P1-5)", () => {
    const root = mkdtempSync(join(tmpdir(), "holdouts-"));
    const store = new HoldoutStore(root);
    expect(store.isInside(join(root, "p", "t.json"))).toBe(true);
    expect(store.isInside(`${root}-evil/t.json`)).toBe(false);
    expect(() => store.assertOutside(join(root, ".."))).toThrow("outside the worktree");
    expect(() => store.assertOutside("/tmp/wt/T-1")).not.toThrow();
  });

  test("rejects path traversal in ids", async () => {
    const store = new HoldoutStore(mkdtempSync(join(tmpdir(), "holdout-")));
    await expect(store.save("../x", "T-1", [])).rejects.toThrow("unsafe");
    await expect(store.load("pilot", "../../etc/passwd")).rejects.toThrow("unsafe");
    expect(await store.load("pilot", "missing")).toEqual([]);
  });
});

describe("privateQaCause", () => {
  test("keeps the cause, masks secrets, single line, bounded", () => {
    const out = privateQaCause(
      new Error(
        "orca failed\nBearer abc.def api_key: s3cr3tvalue sk-0123456789abcdef mxr_abcdefgh",
      ),
    );
    expect(out).toContain("orca failed");
    for (const leak of ["abc.def", "s3cr3tvalue", "sk-0123456789abcdef", "mxr_abcdefgh", "\n"])
      expect(out).not.toContain(leak);
    expect(privateQaCause(new Error("x".repeat(1000))).length).toBeLessThanOrEqual(301);
    const auth = privateQaCause(new Error("Authorization: Basic dXNlcjpwYXNz\u2028next"));
    expect(auth).not.toContain("dXNlcjpwYXNz");
    const path = "/home/neo/.matrix/scratch/run-0123456789abcdef0123456789abcdef-x1";
    expect(privateQaCause(new Error(`selector_not_found path:${path}`))).toContain("/scratch/");
  });

  test("never echoes parse errors (they can quote holdout text)", () => {
    expect(privateQaCause(new SyntaxError('Unexpected token, "given a secret scenario"'))).toBe(
      "model output was not valid JSON",
    );
    expect(privateQaCause("thrown string")).toBe("non-Error failure");
  });
});
