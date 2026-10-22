import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  detectChecks,
  githubSlug,
  parseRepoRoots,
  resolveExistingRepo,
  validBranch,
} from "./existing-repo.js";
import { git, makeRepo } from "./existing-repo.test-helpers.js";

const setup = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "matrix-existing-")));
  const root = join(base, "Projects");
  mkdirSync(root);
  return { base, root };
};

describe("resolveExistingRepo", () => {
  test("accepts an allowlisted canonical repo with a GitHub remote", async () => {
    const { root } = setup();
    const repo = makeRepo(root, "wayline");
    await expect(
      resolveExistingRepo({ path: repo, baseBranch: "main" }, [root], []),
    ).resolves.toEqual({
      path: repo,
      baseBranch: "main",
      remote: "origin",
      github: "acme/wayline",
    });
  });

  test("is off without MATRIX_REPO_ROOTS", async () => {
    const { root } = setup();
    const repo = makeRepo(root, "wayline");
    await expect(resolveExistingRepo({ path: repo, baseBranch: "main" }, [], [])).rejects.toThrow(
      /disabled/,
    );
  });

  test("refuses paths outside the roots, traversal and symlink escapes", async () => {
    const { base, root } = setup();
    const outside = makeRepo(base, "outside");
    const check = (path: string) => resolveExistingRepo({ path, baseBranch: "main" }, [root], []);
    await expect(check(outside)).rejects.toThrow(/outside MATRIX_REPO_ROOTS/);
    await expect(check(join(root, "..", "outside"))).rejects.toThrow(/outside/);
    symlinkSync(outside, join(root, "link"));
    await expect(check(join(root, "link"))).rejects.toThrow(/outside/);
    await expect(check("relative/path")).rejects.toThrow(/absolute/);
    await expect(check(join(root, "missing"))).rejects.toThrow(/does not exist/);
  });

  test("resolves an in-root symlink to the real repo path", async () => {
    const { root } = setup();
    const repo = makeRepo(root, "real");
    symlinkSync(repo, join(root, "alias"));
    const resolved = await resolveExistingRepo(
      { path: join(root, "alias"), baseBranch: "main" },
      [root],
      [],
    );
    expect(resolved.path).toBe(repo);
    await expect(
      resolveExistingRepo({ path: join(root, "alias"), baseBranch: "main" }, [root], [repo]),
    ).rejects.toThrow(/already registered/);
  });

  test("refuses worktrees, missing branches, bad names and non-GitHub remotes", async () => {
    const { root } = setup();
    const repo = makeRepo(root, "app");
    git(repo, "worktree", "add", "-q", join(root, "wt"), "-b", "side");
    const check = (path: string, baseBranch = "main", remote?: string) =>
      resolveExistingRepo({ path, baseBranch, ...(remote ? { remote } : {}) }, [root], []);
    await expect(check(join(root, "wt"))).rejects.toThrow(/canonical/);
    await expect(check(repo, "develop")).rejects.toThrow(/does not exist/);
    await expect(check(repo, "--upload-pack=x")).rejects.toThrow(/invalid base branch/);
    await expect(check(repo, "main", "-x")).rejects.toThrow(/invalid remote/);
    await expect(check(repo, "main", "upstream")).rejects.toThrow(/not configured/);
    git(repo, "remote", "add", "gl", "https://gitlab.com/acme/app.git");
    await expect(check(repo, "main", "gl")).rejects.toThrow(/not a github.com/);
  });
});

test("githubSlug only accepts plain github.com remotes", () => {
  expect(githubSlug("https://github.com/acme/app.git")).toBe("acme/app");
  expect(githubSlug("https://github.com/acme/app")).toBe("acme/app");
  expect(githubSlug("git@github.com:acme/app.git")).toBe("acme/app");
  expect(githubSlug("ssh://git@github.com/acme/app.git")).toBe("acme/app");
  expect(githubSlug("https://x-access-token:secret@github.com/acme/app.git")).toBeUndefined();
  expect(githubSlug("https://github.com.evil.test/acme/app")).toBeUndefined();
  expect(githubSlug("https://github.com/acme/app/extra")).toBeUndefined();
});

test("branch names and repo roots are validated", () => {
  expect(validBranch("main")).toBe(true);
  expect(validBranch("release/1.2")).toBe(true);
  for (const bad of ["-x", "a..b", "a b", "x.lock", "a/", "a@{1}", "a:b"])
    expect(validBranch(bad)).toBe(false);
  expect(parseRepoRoots("/a: /b ::")).toEqual(["/a", "/b"]);
  expect(parseRepoRoots(undefined)).toEqual([]);
  expect(() => parseRepoRoots("rel")).toThrow(/absolute/);
});

test("default checks come from the committed package.json and lockfile", async () => {
  const { root } = setup();
  const repo = makeRepo(root, "bunapp", {
    "package.json": JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest", dev: "x" } }),
    "bun.lock": "{}",
  });
  // Uncommitted changes in the working tree are ignored.
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { lint: "evil" } }));
  expect(await detectChecks({ path: repo, baseBranch: "main" })).toEqual([
    { kind: "typecheck", cmd: ["bun", "run", "typecheck"] },
    { kind: "test", cmd: ["bun", "run", "test"] },
  ]);
  const bare = makeRepo(root, "plain");
  expect(await detectChecks({ path: bare, baseBranch: "main" })).toEqual([]);
  const npm = makeRepo(root, "npmapp", {
    "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
  });
  expect(await detectChecks({ path: npm, baseBranch: "main" })).toEqual([
    { kind: "lint", cmd: ["npm", "run", "lint"] },
  ]);
});
