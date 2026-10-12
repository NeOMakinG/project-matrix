import { describe, expect, it } from "vitest";
import { safeRedirect } from "./login-page";

describe("safeRedirect", () => {
  it("keeps same-origin paths and rejects everything else", () => {
    expect(safeRedirect("/p/ledgerly/board?x=1")).toBe("/p/ledgerly/board?x=1");
    for (const bad of [
      "https://evil.io",
      "//evil.io",
      "/\\evil.io",
      "javascript:alert(1)",
      undefined,
      3,
    ]) {
      expect(safeRedirect(bad)).toBe("/");
    }
  });
});
