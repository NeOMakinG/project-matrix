import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { scanCommittedHistory } from "./secret-scan.js";

const available = (() => {
  try {
    execFileSync("gitleaks", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("actual committed history scanner", () => {
  test.skipIf(!available)(
    "detects a canary despite agent-controlled allowlists; scans the requested range",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "matrix-history-canary-"));
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args],
          { encoding: "utf8" },
        ).trim();
      git("init", "-q", "-b", "main");
      git("commit", "--allow-empty", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(
        join(repo, "canary.txt"),
        `token = "ghp_${randomBytes(27).toString("base64url").replace(/[_-]/g, "Z")}"\n`,
      );
      writeFileSync(join(repo, ".gitleaks.toml"), '[allowlist]\npaths = [".*"]\n');
      writeFileSync(join(repo, ".gitleaksignore"), "*\n");
      git("add", ".");
      git("commit", "-qm", "canary");
      writeFileSync(
        join(repo, ".gitleaksignore"),
        `${git("rev-parse", "HEAD")}:canary.txt:github-pat:1\n`,
      );
      git("add", ".gitleaksignore");
      git("commit", "-qm", "agent allowlist");
      const result = await scanCommittedHistory(repo, `${base}..HEAD`);
      expect(result.ok).toBe(false);
      expect(result.data).toEqual(
        expect.objectContaining({
          findings: expect.arrayContaining([expect.objectContaining({ rule: "github-pat" })]),
        }),
      );
      expect((await scanCommittedHistory(repo, `${base}..${base}`)).ok).toBe(true);
    },
  );

  test("missing scanner fails closed", async () => {
    expect(
      (
        await scanCommittedHistory(
          mkdtempSync(join(tmpdir(), "matrix-no-scanner-")),
          "HEAD",
          "/nonexistent/matrix-gitleaks",
        )
      ).ok,
    ).toBe(false);
  });
});
