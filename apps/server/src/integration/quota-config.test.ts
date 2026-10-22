import { DEFAULT_QUOTA } from "@matrix/core";
import { describe, expect, test } from "vitest";
import { parseQuotaEnv, resolveQuota } from "./quota-config.js";

describe("MATRIX_QUOTA", () => {
  test("empty env keeps the conservative defaults", () => {
    expect(resolveQuota(parseQuotaEnv(undefined))).toEqual({ quota: DEFAULT_QUOTA });
    expect(DEFAULT_QUOTA.defaults.maxConcurrent).toBe(2);
  });

  test("per-provider overrides merge over defaults", () => {
    const { quota, maxRequeuesPerDay } = resolveQuota(
      parseQuotaEnv(
        '{"providers":{"codex":{"maxConcurrent":1}},"cooldown":{"maxMs":7200000},"maxRequeuesPerDay":5}',
      ),
    );
    expect(quota.providers.codex).toEqual({ maxConcurrent: 1 });
    expect(quota.cooldown).toEqual({ baseMs: 60_000, maxMs: 7_200_000 });
    expect(maxRequeuesPerDay).toBe(5);
  });

  test("rejects unknown keys, bad JSON and inverted cooldowns", () => {
    expect(() => parseQuotaEnv('{"defaults":{"maxConcurent":1}}')).toThrow(/MATRIX_QUOTA/);
    expect(() => parseQuotaEnv("{")).toThrow(/MATRIX_QUOTA/);
    expect(() => resolveQuota({ cooldown: { baseMs: 10_000, maxMs: 5_000 } })).toThrow(/maxMs/);
  });
});
