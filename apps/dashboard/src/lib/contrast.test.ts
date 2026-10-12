import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
const token = (name: string): string => {
  const match = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`token ${name} missing`);
  return match[1];
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("text contrast (WCAG AA, 4.5:1)", () => {
  const backgrounds = ["canvas", "surface", "raised", "hover"];
  for (const fg of ["fg", "fg-secondary", "fg-muted"]) {
    for (const bg of backgrounds) {
      it(`${fg} on ${bg}`, () => {
        expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  for (const [fg, bg] of [
    ["accent", "accent-dim"],
    ["info", "info-dim"],
    ["warn", "warn-dim"],
    ["danger", "danger-dim"],
    ["violet", "violet-dim"],
    ["fg-muted", "accent-dim"],
  ] as const) {
    it(`${fg} pill text on ${bg}`, () => {
      expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
