import { expect, test } from "vitest";
import { name } from "./index";

test("package name", () => {
  expect(name).toBe("@matrix/config");
});

test("linear tracker settings hold an env var name, never a key", async () => {
  const { linearTickets, processConfig } = await import("./schema");
  const base = {
    tickets: "linear",
    branching: "trunk-with-prs",
    autonomy: { merge: "human", deploy: "human" },
    reviewLanes: ["correctness-security"],
    budgets: { dailyUsd: 1, perTicketUsd: 1 },
  };
  expect(processConfig.safeParse(base).success).toBe(true);
  const parsed = processConfig.parse({
    ...base,
    linear: { teamKey: "NEO", projectLabel: "project:personal" },
  });
  expect(parsed.linear).toEqual({
    teamKey: "NEO",
    projectLabel: "project:personal",
    readyState: "Ready",
    apiKeyEnv: "LINEAR_API_KEY",
  });
  expect(
    linearTickets.safeParse({ teamKey: "NEO", projectLabel: "p", apiKeyEnv: "lin_api_abc" })
      .success,
  ).toBe(false);
});
