import { secretNeedles } from "@matrix/sandbox";
import { expect, test } from "vitest";
import { redactNativeDiagnostic } from "./native-diagnostics.js";

test("combined matcher preserves literal/encoded values, patterns and assignment coverage", () => {
  const key = "fixture.$[secret](value)+?";
  const redact = redactNativeDiagnostic([key]);
  for (const variant of secretNeedles(key)) expect(redact(variant.toString())).toBe("[REDACTED]");
  expect(redact(`status=${key}; reason='${Buffer.from(key).toString("base64")}'`)).not.toContain(
    key,
  );
  expect(
    redact(
      "status=500 API_KEY='arbitrary value' api-key: arbitrary token = arbitrary prefixFOO=arbitrary PASSWORD=arbitrary",
    ),
  ).toBe(
    "status=500 API_KEY=[REDACTED] api-key: [REDACTED] token = [REDACTED] prefixFOO=[REDACTED] PASSWORD=[REDACTED]",
  );
  expect(redact("bEaReR arbitrary sk-unknown mxr_unknown")).toBe(
    "Bearer [REDACTED] [REDACTED] [REDACTED]",
  );
  expect(redact("useful\nheaders\n : {\n arbitrary secret\n}")).toBe(
    "useful\n[REDACTED execution context]",
  );
  expect(redact("useful\nCommand failed: tool --token arbitrary\nother useful")).toBe(
    "useful\n[REDACTED execution context]\nother useful",
  );
});

test("long identifiers are linear; oversized input fails closed without exposing a cut secret", () => {
  const started = performance.now();
  const key = "fixture-secret-that-straddles-the-input-limit";
  const redact = redactNativeDiagnostic([key]);
  for (let index = 0; index < 100; index++) {
    const word = "x".repeat(8192);
    expect(redact(word)).toBe(word);
    expect(redact(`${"x".repeat(8180)}${key}`)).toBe("[REDACTED oversized diagnostic; truncated]");
  }
  expect(redact("x".repeat(1_000_000))).toBe("[REDACTED oversized diagnostic; truncated]");
  expect(performance.now() - started).toBeLessThan(1000);
});
