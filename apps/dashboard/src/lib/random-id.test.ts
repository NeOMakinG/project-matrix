import { afterEach, describe, expect, test, vi } from "vitest";
import { randomId } from "./random-id";

describe("randomId", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("works without crypto.randomUUID (insecure HTTP context)", () => {
    const { getRandomValues } = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: getRandomValues.bind(globalThis.crypto) });
    const ids = new Set(Array.from({ length: 100 }, randomId));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
