import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { initProjectRepo } from "./factory.js";
import { createRuntime, parseRuntimeKind, RuntimeUnavailableError } from "./runtime.js";

const hasBd = (() => {
  try {
    execFileSync("bd", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("project repo bootstrap", () => {
  test("git repo on main with an initial commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-repo-"));
    await initProjectRepo(dir, { kind: "markdown" });
    const branch = execFileSync("git", ["-C", dir, "branch", "--show-current"]).toString().trim();
    const commits = execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"])
      .toString()
      .trim();
    expect(branch).toBe("main");
    expect(commits).toBe("1");
  }, 30_000);

  test.runIf(hasBd)(
    "beads database in stealth mode for beads projects",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "matrix-beads-"));
      await initProjectRepo(dir, { kind: "beads" });
      const status = execFileSync("git", ["-C", dir, "status", "--porcelain"]).toString();
      expect(status).not.toContain(".beads");
    },
    60_000,
  );
});

describe("runtime switch", () => {
  test("defaults to native and refuses to start without its configuration", () => {
    expect(parseRuntimeKind(undefined)).toBe("native");
    expect(() => createRuntime("native")).toThrow(RuntimeUnavailableError);
    expect(() => parseRuntimeKind("cloud")).toThrow(RuntimeUnavailableError);
    expect(createRuntime("fake").kind).toBe("fake");
  });
});
