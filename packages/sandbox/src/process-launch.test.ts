import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { hostExecutor } from "./process.js";

test("a known executable with missing CWD reports safe existence/resolution, not argv or environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "matrix-launch-cwd-"));
  try {
    const secret = "planted-env-and-argv-DO-NOT-PRINT";
    const launch = hostExecutor(
      {
        cmd: [process.execPath, "-e", "", secret],
        cwd: join(directory, "new-data-dir", "worktrees"),
        env: { PATH: dirname(process.execPath), KEY: secret },
        timeoutMs: 1000,
      },
      () => {},
      new AbortController().signal,
    );
    await expect(launch).rejects.toMatchObject({ code: "ENOENT" });
    await launch.catch(async (error: Error) => {
      expect(error.message).toBe(
        `host launch failed (ENOENT); cwdExists=false; resolvedToolPath=${await realpath(process.execPath)}`,
      );
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain("KEY");
      expect(error.message).not.toContain("-e");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing executable is distinguished from missing CWD without printing raw command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "matrix-launch-tool-"));
  try {
    const launch = hostExecutor(
      {
        cmd: ["nonexistent-planted-private-tool"],
        cwd: directory,
        env: { PATH: directory },
        timeoutMs: 1000,
      },
      () => {},
      new AbortController().signal,
    );
    await expect(launch).rejects.toThrow("cwdExists=true; resolvedToolPath=unavailable");
    await launch.catch((error: Error) =>
      expect(error.message).not.toContain("planted-private-tool"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
