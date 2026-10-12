import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { ciWorkflow, toolCommit } from "./ci";

test("generated CI pins tooling to a commit on the tool's main line, never a branch commit", () => {
  const pinned = toolCommit();
  if (pinned) {
    const onMain = spawnSync("git", ["merge-base", "--is-ancestor", pinned, "origin/main"], {
      cwd: import.meta.dirname,
    });
    expect(onMain.status).toBe(0);
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
    });
    const headOnMain = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", head.stdout.trim(), "origin/main"],
      {
        cwd: import.meta.dirname,
      },
    );
    if (headOnMain.status !== 0) expect(pinned).not.toBe(head.stdout.trim());
  }
  const yaml = ciWorkflow({} as never, "a".repeat(40));
  expect(yaml).toContain(`ref: ${"a".repeat(40)}`);
  expect(ciWorkflow({} as never, null)).toContain("pin a commit SHA here");
});
