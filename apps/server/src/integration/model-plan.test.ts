import { recommendedModels } from "@matrix/config";
import { expect, test } from "vitest";
import { newProjectConfig } from "./mapping.js";
import { applyModelPlan, assertKnownModels, configModelIds } from "./model-plan.js";

/** What the CLIProxyAPI gateway on bosgame served on 2026-10-22 (subset). */
const SERVED = ["claude-opus-4-7", "claude-sonnet-5-5", "claude-fable-5-1", "gpt-6-sol", "GLM-5.1"];

const project = () =>
  newProjectConfig({
    id: "p",
    name: "p",
    repoPath: "/tmp/p",
    host: "test",
    meta: {
      description: "",
      workspace: "native",
      tickets: { kind: "beads" },
      createdAt: "2026-10-22T00:00:00Z",
    },
  });

test("default models are ids the gateway actually serves", async () => {
  const ids = configModelIds(project());
  expect(ids).toEqual(
    expect.arrayContaining(["claude-opus-4-7", "claude-sonnet-5-5", "gpt-6-sol"]),
  );
  expect(ids).not.toContain("claude-opus-5-5");
  await expect(assertKnownModels(ids, async () => SERVED)).resolves.toBeUndefined();
  expect(JSON.stringify(recommendedModels)).not.toContain("claude-opus-5-5");
});

test("every phase, tier, fallback and alias target is checked, not only the posted plan", async () => {
  const config = project();
  config.models.aliases = { opus: "claude-opus-5-5" };
  applyModelPlan(config, {
    spike: { runner: "claude-code", model: "opus" },
    review: { runner: "codex", model: "gpt-6-sol" },
    reviewerFallbacks: [{ runner: "claude-code", model: "GLM-9" }],
  });
  const ids = configModelIds(config);
  expect(ids).toEqual(expect.arrayContaining(["claude-opus-5-5", "GLM-9", "claude-opus-4-7"]));
  await expect(assertKnownModels(ids, async () => SERVED)).rejects.toThrow(
    "model(s) not served by the gateway: claude-opus-5-5, GLM-9",
  );
});

test("an unanswered model list fails closed; no lister means no gateway to check", async () => {
  await expect(assertKnownModels(["gpt-6-sol"], async () => undefined)).rejects.toThrow(
    /cannot verify model ids \(gpt-6-sol\)/,
  );
  await expect(assertKnownModels(["anything"])).resolves.toBeUndefined();
});
