import { expect, test } from "vitest";
import { UpdateProject } from "../http/schemas.js";
import { applyRunSettings, type StoredProject, validQaSettings } from "./mapping.js";

test("qa settings are validated, stored and cleared host-side", () => {
  expect(validQaSettings({ surfaces: ["android", "android"], driver: "manual" })).toEqual({
    surfaces: ["android"],
    driver: "manual",
  });
  expect(validQaSettings({ surfaces: ["web"], driver: "none" })).toEqual({ surfaces: ["web"] });
  expect(() => validQaSettings({ surfaces: ["watch" as "web"] })).toThrow(/unknown qa surface/);
  expect(() => validQaSettings({ driver: "auto" as "none" })).toThrow(/none, manual or agent/);

  const config = {} as StoredProject;
  applyRunSettings(config, { qa: { surfaces: ["android"], driver: "manual" } });
  expect(config.qa).toEqual({ surfaces: ["android"], driver: "manual" });
  applyRunSettings(config, { qa: null });
  expect(config.qa).toBeUndefined();
});

test("PATCH body accepts the qa object and rejects unknown fields", () => {
  expect(UpdateProject.safeParse({ qa: { surfaces: ["android"], driver: "manual" } }).success).toBe(
    true,
  );
  expect(UpdateProject.safeParse({ qa: { surfaces: ["android"], skip: true } }).success).toBe(
    false,
  );
  expect(UpdateProject.safeParse({ qa: null }).success).toBe(true);
});
