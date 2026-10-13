import { describe, expect, test } from "vitest";
import { findContradictions } from "./contradictions";
import { buildConfig, decisions, inferAnswers, nextRound, resolve } from "./engine";
import { sampleAnswers } from "./fixtures";
import { defaultPacks } from "./index";

describe("design tree", () => {
  test("first round asks only questions without dependencies", () => {
    const ids = nextRound(defaultPacks, {}).map((q) => q.id);
    expect(ids).toContain("business.name");
    expect(ids.every((id) => id.startsWith("business."))).toBe(true);
    expect(ids).not.toContain("frontend.framework");
    expect(ids).not.toContain("product.mvpScope");
  });

  test("React questions appear only once web + react are chosen", () => {
    const a = { ...sampleAnswers, "frontend.framework": "react" };
    expect(nextRound(defaultPacks, a).map((q) => q.id)).toContain("frontend.data");
    const apiOnly = { ...sampleAnswers, "platforms.targets": ["api-only"] };
    const ids = nextRound(defaultPacks, apiOnly).map((q) => q.id);
    expect(ids).not.toContain("frontend.framework");
  });

  test("resolve walks several rounds and stops", () => {
    const r = resolve(defaultPacks, sampleAnswers, { acceptRecommended: true });
    expect(r.rounds.length).toBeGreaterThan(1);
    expect(r.missing).toEqual([]);
    expect(r.answers["frontend.data"]).toBe("tanstack-query");
    expect(r.answers["backend.orm"]).toBe("drizzle");
  });

  test("without recommendations, unanswerable questions are reported", () => {
    const r = resolve(defaultPacks, {}, { acceptRecommended: false });
    expect(r.missing.map((q) => q.id)).toContain("business.name");
  });
});

describe("config", () => {
  test("interview recommends the tiered model plan and preserves custom aliases", () => {
    const { answers } = resolve(defaultPacks, sampleAnswers, { acceptRecommended: true });
    const built = buildConfig(defaultPacks, answers);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.config.models.tiers).toEqual({
      large: { runner: "claude-code", model: "claude-opus-5-5" },
      small: { runner: "claude-code", model: "claude-sonnet-5-5" },
    });
    expect(built.config.models.review).toEqual({ runner: "codex", model: "gpt-6-sol" });
    const custom = buildConfig(defaultPacks, {
      ...answers,
      "models.plan": JSON.stringify({
        ...built.config.models,
        aliases: { "claude-opus-5-5": "claude-opus-4-7" },
      }),
    });
    expect(custom.ok && custom.config.models.aliases).toEqual({
      "claude-opus-5-5": "claude-opus-4-7",
    });
    expect(buildConfig(defaultPacks, { ...answers, "models.plan": "not json" }).ok).toBe(false);
  });
  test("sample answers build a valid config", () => {
    const { answers } = resolve(defaultPacks, sampleAnswers, { acceptRecommended: true });
    const built = buildConfig(defaultPacks, answers);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.config.frontend).toMatchObject({ framework: "react", data: "tanstack-query" });
    expect(built.config.product.mvpScope).toEqual([
      "invoices",
      "automatic reminders",
      "payment links",
    ]);
    expect(built.config.product.personas[0]).toEqual({
      name: "Freelancer",
      goal: "get paid on time",
    });
  });

  test("missing required business fields fail validation", () => {
    const built = buildConfig(defaultPacks, {});
    expect(built.ok).toBe(false);
  });

  test("significant choices produce decisions with rule stubs", () => {
    const { answers } = resolve(defaultPacks, sampleAnswers, { acceptRecommended: true });
    const ds = decisions(defaultPacks, answers);
    const data = ds.find((d) => d.topic === "server state management");
    expect(data?.decision).toBe("TanStack Query");
    expect(data?.rules[0]?.engine).toBe("ast-grep");
  });
});

describe("inference", () => {
  test("existing repo dependencies pre-fill answers", () => {
    const inferred = inferAnswers(defaultPacks, {
      dependencies: new Set(["react", "react-dom", "@tanstack/react-query", "hono", "drizzle-orm"]),
      files: new Set([".github/workflows/ci.yml"]),
      env: {},
    });
    expect(inferred["frontend.framework"]).toBe("react");
    expect(inferred["frontend.data"]).toBe("tanstack-query");
    expect(inferred["backend.kind"]).toBe("node-api");
    expect(inferred["quality.ci"]).toBe("github-actions");
  });
});

describe("contradictions", () => {
  test("offline-first without sync is an error", () => {
    const c = findContradictions({ "product.offlineFirst": true, "product.syncStrategy": "none" });
    expect(c.map((x) => x.id)).toContain("offline-without-sync");
  });

  test("deploy can't be more autonomous than merge", () => {
    const c = findContradictions({
      "process.autonomy.merge": "human",
      "process.autonomy.deploy": "autonomous",
    });
    expect(c[0]?.severity).toBe("error");
  });

  test("recommended answers for the sample have no errors", () => {
    const { answers } = resolve(defaultPacks, sampleAnswers, { acceptRecommended: true });
    expect(findContradictions(answers).filter((c) => c.severity === "error")).toEqual([]);
  });
});

describe("every branch of the design tree builds a valid config", () => {
  test("each select/confirm option, with recommendations elsewhere, is valid or a reported contradiction", () => {
    const failures: string[] = [];
    for (const q of defaultPacks.flatMap((p) => p.questions)) {
      const values: (string | boolean)[] =
        q.kind === "confirm"
          ? [true, false]
          : q.kind === "select"
            ? (q.options ?? []).map((o) => o.value)
            : [];
      for (const v of values) {
        const given = { ...sampleAnswers, [q.id]: v };
        if (q.id === "frontend.framework" && v === "other") given["frontend.name"] = "svelte";
        const { answers, missing } = resolve(defaultPacks, given, { acceptRecommended: true });
        if (missing.length > 0) continue;
        if (findContradictions(answers).some((c) => c.severity === "error")) continue;
        const built = buildConfig(defaultPacks, answers);
        if (!built.ok) failures.push(`${q.id}=${String(v)}: ${JSON.stringify(built.issues)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("figma off yields a valid config with designFirst false", () => {
    const { answers } = resolve(
      defaultPacks,
      { ...sampleAnswers, "agents.figmaMcp": false },
      { acceptRecommended: true },
    );
    const built = buildConfig(defaultPacks, answers);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.config.agents.designFirst).toBe(false);
  });
});
