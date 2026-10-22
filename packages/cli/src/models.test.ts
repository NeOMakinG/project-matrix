import { modelsConfig, recommendedModels } from "@matrix/config";
import { describe, expect, test } from "vitest";
import { configuredModels, modelsCommand } from "./models";

const plan = { ...recommendedModels, aliases: { "claude-opus-4-7": "opus-gateway" } };

describe("gateway model check", () => {
  test("reads generated config without executing code and resolves aliases", () => {
    expect(
      configuredModels(
        `const config = ${JSON.stringify({ models: plan })} as const;\nexport default config;`,
      ),
    ).toEqual([
      { logical: "claude-opus-4-7", resolved: "opus-gateway" },
      { logical: "claude-sonnet-5-5", resolved: "claude-sonnet-5-5" },
      { logical: "gpt-6-sol", resolved: "gpt-6-sol" },
    ]);
    expect(() =>
      configuredModels('export default (() => { throw new Error("EXECUTED") })()'),
    ).toThrow("not valid JSON");
  });

  test.each([true, false])("only GETs /v1/models; presence=%s", async (present) => {
    const lines: string[] = [];
    const requests: string[] = [];
    const status = await modelsCommand(
      ["check", "--gateway", "http://127.0.0.1:9000/v1", "--config", "plan.json"],
      {
        token: "",
        readConfig: async (file) => {
          expect(file).toBe("plan.json");
          return JSON.stringify({ models: plan });
        },
        write: (line) => lines.push(line),
        fetchImpl: (async (input, init) => {
          requests.push(String(input));
          expect(init?.method).toBe("GET");
          expect(init?.body).toBeUndefined();
          return new Response(
            JSON.stringify({
              data: (present
                ? ["opus-gateway", "claude-sonnet-5-5", "gpt-6-sol"]
                : ["claude-opus-4-7"]
              ).map((id) => ({ id })),
            }),
          );
        }) as typeof fetch,
      },
    );
    expect(requests).toEqual(["http://127.0.0.1:9000/v1/models"]);
    expect(status).toBe(present ? 0 : 2);
    expect(lines[0]).toBe(
      `claude-opus-4-7 -> opus-gateway: ${present ? "available" : "MISSING"}`,
    );
  });

  test("schema preserves phase defaults, tiers, threshold and aliases; rejects bad runners", () => {
    expect(modelsConfig.parse(plan)).toEqual(plan);
    expect(
      modelsConfig.safeParse({
        ...plan,
        tiers: { ...plan.tiers, small: { runner: "unknown", model: "model" } },
      }).success,
    ).toBe(false);
    expect(modelsConfig.safeParse({ ...plan, smallEstimateThreshold: 0 }).success).toBe(false);
  });

  test("HTTP errors fail without exposing response credentials", async () => {
    await expect(
      modelsCommand(["check", "--gateway", "https://gateway.example"], {
        token: "",
        readConfig: async () => JSON.stringify({ models: plan }),
        fetchImpl: (async () => new Response("secret", { status: 401 })) as typeof fetch,
      }),
    ).rejects.toThrow("HTTP 401");
  });
});
