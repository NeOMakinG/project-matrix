import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HoldoutStore, holdoutReceipt, parseScenarios, parseVerdicts } from "./holdout.js";
import { parseFindings, pickReviewer, reviewReceipt } from "./review.js";
import { testProject } from "./testing/fakes.js";

describe("model output parsing", () => {
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

  test("throws when no different model is available", () => {
    const cfg = testProject({ reviewerFallbacks: [] });
    expect(() => pickReviewer(cfg, "gpt-6.1-sol")).toThrow();
  });
});

describe("holdout store", () => {
  test("rejects path traversal in ids", async () => {
    const store = new HoldoutStore(mkdtempSync(join(tmpdir(), "holdout-")));
    await expect(store.save("../x", "T-1", [])).rejects.toThrow("unsafe");
    await expect(store.load("pilot", "../../etc/passwd")).rejects.toThrow("unsafe");
    expect(await store.load("pilot", "missing")).toEqual([]);
  });
});
