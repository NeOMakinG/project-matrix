import { spawnSync } from "node:child_process";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { gitignoreGlobs, scanSources } from "./files";
import { fixtureProject } from "./test-utils";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

describe("scanSources", () => {
  test("never hides code by basename at depth; honours the root .gitignore", async () => {
    const root = await fixtureProject({
      ".gitignore": "/dist\nnode_modules/\n",
      "src/a.ts": "export const a = 1;\n",
      "src/build/hidden.ts": 'import "drizzle-orm";\n',
      "apps/x/coverage/c.ts": "export {};\n",
      "dist/out.js": "export {};\n",
      "src/node_modules/dep/index.js": "export {};\n",
      ".matrix/graph/x.ts": "export {};\n",
    });
    const s = await scanSources(root);
    expect(s.via).toBe("walk");
    expect(s.files).toEqual(["apps/x/coverage/c.ts", "src/a.ts", "src/build/hidden.ts"]);
  });

  test("in git: tracked files in ignored folders are still checked", async () => {
    const root = await fixtureProject({
      ".gitignore": "build/\n",
      "src/a.ts": "export const a = 1;\n",
      "build/committed.ts": "export const c = 1;\n",
    });
    git(root, "init", "-q");
    git(root, "add", "-f", "src/a.ts", "build/committed.ts", ".gitignore");
    git(root, "commit", "-q", "-m", "init");
    await (await import("node:fs/promises")).writeFile(
      join(root, "build/untracked.ts"),
      "export {};\n",
    );
    const s = await scanSources(root);
    expect(s.via).toBe("git");
    expect(s.files).toEqual(["build/committed.ts", "src/a.ts"]);
  });

  test("symlinks: inside the repo are checked, outside are reported as escapes", async () => {
    const outside = await fixtureProject({ "secret.ts": 'import "drizzle-orm";\n' });
    const root = await fixtureProject({ "src/real.ts": "export const r = 1;\n" });
    await symlink(join(root, "src/real.ts"), join(root, "src/alias.ts"));
    await symlink(join(outside, "secret.ts"), join(root, "src/escape.ts"));
    await symlink(outside, join(root, "src/vendor"));
    const s = await scanSources(root);
    expect(s.files).toEqual(["src/alias.ts", "src/real.ts"]);
    expect(s.escapes.map((e) => e.path)).toEqual(["src/escape.ts", "src/vendor"]);
  });
});

test("gitignore globs follow git semantics", () => {
  expect(gitignoreGlobs("# c\n/dist\nbuild/\n*.log\na/b\n!keep")).toEqual([
    "dist/**",
    "dist",
    "**/build/**",
    "**/*.log/**",
    "**/*.log",
    "a/b/**",
    "a/b",
  ]);
});
