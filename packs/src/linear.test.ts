import { expect, test } from "vitest";
import { buildConfig, resolve } from "./engine";
import { sampleAnswers } from "./fixtures";
import { defaultPacks } from "./index";

const LINEAR_IDS = [
  "process.linear.teamKey",
  "process.linear.projectLabel",
  "process.linear.readyState",
  "process.linear.apiKeyEnv",
];

test("Linear questions exist only when Linear is the tracker", () => {
  const beads = resolve(
    defaultPacks,
    { ...sampleAnswers, "process.tickets": "beads" },
    {
      acceptRecommended: true,
    },
  );
  expect(beads.rounds.flat().filter((id) => id.startsWith("process.linear."))).toEqual([]);
  const linear = resolve(
    defaultPacks,
    { ...sampleAnswers, "process.tickets": "linear" },
    {
      acceptRecommended: true,
    },
  );
  expect(linear.missing.map((q) => q.id).sort()).toEqual(
    ["process.linear.projectLabel", "process.linear.teamKey"].sort(),
  );
  expect(linear.answers["process.linear.apiKeyEnv"]).toBe("LINEAR_API_KEY");
  expect(linear.rounds.flat()).toEqual(expect.arrayContaining(LINEAR_IDS));
});

test("answers build a valid linear config; a key in apiKeyEnv is rejected", () => {
  const answers = {
    ...sampleAnswers,
    "process.tickets": "linear",
    "process.linear.teamKey": "NEO",
    "process.linear.projectLabel": "project:demo",
  };
  const { answers: full } = resolve(defaultPacks, answers, { acceptRecommended: true });
  const built = buildConfig(defaultPacks, full);
  expect(built.ok && built.config.process.linear).toEqual({
    teamKey: "NEO",
    projectLabel: "project:demo",
    readyState: "Ready",
    apiKeyEnv: "LINEAR_API_KEY",
  });
  const leaked = buildConfig(defaultPacks, {
    ...full,
    "process.linear.apiKeyEnv": "lin_api_secretsecret",
  });
  expect(leaked.ok).toBe(false);
});
