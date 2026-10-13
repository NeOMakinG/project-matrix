import { describe, expect, test } from "vitest";
import { resolveModel, selectModel } from "./models.js";
import { pickReviewer } from "./review.js";
import { testProject } from "./testing/fakes.js";
import { createHarness } from "./testing/harness.js";

const models = {
  implement: { runner: "claude-code", model: "opus" },
  review: { runner: "codex", model: "review" },
  design: { runner: "codex", model: "design" },
  tiers: {
    large: { runner: "claude-code", model: "opus" },
    small: { runner: "claude-code", model: "sonnet" },
  },
  aliases: { opus: "gateway-opus", sonnet: "gateway-sonnet", review: "gateway-review" },
  smallEstimateThreshold: 3,
} as const;

describe("ticket model routing", () => {
  test.each([
    { labels: [], expected: "opus" },
    { labels: ["size:small"], expected: "sonnet" },
    { labels: [], estimate: 2, expected: "sonnet" },
    { labels: [], estimate: 3, expected: "opus" },
    { labels: [], estimate: -1, expected: "opus" },
    { labels: [], estimate: Number.NaN, expected: "opus" },
  ])("selects $expected for $labels/$estimate", ({ expected, ...size }) => {
    const config = testProject({ models });
    const ticket = size;
    expect(selectModel(config, "spike", ticket).model).toBe(expected);
    expect(selectModel(config, "implement", ticket).model).toBe(expected);
    expect(selectModel(config, "design", ticket).model).toBe("design");
    expect(selectModel(config, "review", ticket).model).toBe("review");
    expect(resolveModel(config, "unknown")).toBe("unknown");
  });

  test("legacy phase plans still work without tiers or aliases", () => {
    const config = testProject();
    expect(selectModel(config, "spike")).toEqual(config.models.implement);
    expect(resolveModel(config, config.models.implement.model)).toBe(config.models.implement.model);
  });

  test("aliases cannot disguise self-review, even via another runner", () => {
    const config = testProject({
      models: {
        ...models,
        review: { runner: "codex", model: "disguised" },
        aliases: { ...models.aliases, disguised: "gateway-sonnet" },
      },
    });
    expect(pickReviewer(config, "sonnet").model).toBe("glm-5.3");
    expect(() => pickReviewer({ ...config, reviewerFallbacks: [] }, "sonnet")).toThrow(
      "no reviewer model differs",
    );
  });

  test.each(["small", "large"])(
    "%s ticket uses resolved runner IDs and independent scenario/review/judge models",
    async (size) => {
      const harness = createHarness({ project: { models } });
      await harness.setup();
      const ticket = harness.tickets.add("tier regression");
      if (size === "small") ticket.labels.push("size:small");
      await harness.drain();
      const implementation = size === "small" ? "gateway-sonnet" : "gateway-opus";
      expect(
        harness.implementer.calls
          .filter((request) => request.phase === "spike" || request.phase === "implement")
          .map((request) => request.model),
      ).toEqual([implementation, implementation]);
      expect(
        harness.reviewer.calls
          .filter((request) => ["spike", "review", "qa"].includes(request.phase))
          .every((request) => request.model === "gateway-review"),
      ).toBe(true);
      expect((await harness.store.getWorkflow("pilot", ticket.id))?.status).toBe("done");
      expect((await harness.store.getWorkflow("pilot", ticket.id))?.implementerModel).toBe(
        implementation,
      );
    },
  );

  test("scheduler applies resolved small-tier per-model concurrency limits", async () => {
    const harness = createHarness({
      project: { models },
      limits: { perModel: { "gateway-sonnet": 1 } },
    });
    await harness.setup();
    harness.tickets.add("one").labels.push("size:small");
    harness.tickets.add("two").estimate = 1;
    const report = await harness.reconciler.tick();
    expect(report.dispatched).toHaveLength(1);
    expect(report.skipped[0]?.reason).toBe("model limit gateway-sonnet");
    await harness.reconciler.idle();
  });

  test("review excludes the recorded gateway implementer after aliases change", () => {
    const config = testProject({
      models: {
        ...models,
        aliases: {
          sonnet: "new-sonnet",
          review: "gateway-sonnet",
          "gateway-sonnet": "something-else",
        },
      },
      reviewerFallbacks: [],
    });
    expect(() => pickReviewer(config, "gateway-sonnet")).toThrow("no reviewer model differs");
  });
});
