import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhaseContext, SandboxExecSpec } from "@matrix/core";
import { describe, expect, test } from "vitest";
import { restoreInstall } from "./deps-cache.js";
import { dependencySetup } from "./deps-setup.js";
import { checkDirs, detectSetup } from "./setup-detect.js";

const CHECKS = [
  { kind: "typecheck" as const, cmd: ["npm", "--prefix", "app", "run", "typecheck"] },
  { kind: "lint" as const, cmd: ["pnpm", "-C=web/", "lint"] },
  { kind: "test" as const, cmd: ["npm", "--prefix", "../etc", "test"] },
];

async function worktree(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "matrix-setup-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

describe("setup detection", () => {
  test("check commands name the directories to install", () => {
    expect(checkDirs(CHECKS)).toEqual(["app", "web"]);
  });

  test("one frozen install per dir with a manifest and a lockfile, scripts off", async () => {
    const dir = await worktree({
      "package.json": "{}",
      "bun.lock": "",
      "app/package.json": "{}",
      "app/package-lock.json": "{}",
      "web/package.json": "{}",
    });
    expect(await detectSetup(dir, CHECKS)).toEqual([
      { run: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"] },
      { cwd: "app", run: ["npm", "ci", "--no-audit", "--no-fund", "--ignore-scripts"] },
    ]);
    expect((await detectSetup(dir, CHECKS, true))[1]?.run).toEqual([
      "npm",
      "ci",
      "--no-audit",
      "--no-fund",
    ]);
  });

  test("symlinked manifests or lockfiles are ignored", async () => {
    const dir = await worktree({ "real/package.json": "{}", "real/yarn.lock": "" });
    await symlink(join(dir, "real"), join(dir, "app"));
    expect(await detectSetup(dir, CHECKS)).toEqual([]);
  });
});

function context(workdir: string): PhaseContext {
  return {
    workdir,
    project: { id: "tj", checks: CHECKS },
    emit: () => {},
    signal: new AbortController().signal,
  } as unknown as PhaseContext;
}

describe("dependency setup", () => {
  test("installs in the sandbox with registry-only egress, then restores from cache", async () => {
    const files = { "app/package.json": "{}", "app/package-lock.json": '{"v":1}' };
    const calls: SandboxExecSpec[] = [];
    const sandbox = {
      kind: "podman" as const,
      exec: async (spec: SandboxExecSpec) => {
        calls.push(spec);
        await mkdir(join(spec.workdir, "node_modules/.bin"), { recursive: true });
        await writeFile(join(spec.workdir, "node_modules/.bin/tsc"), "installed");
        return { code: 0, stdout: "added 1 package", stderr: "" };
      },
    };
    const cacheRoot = await mkdtemp(join(tmpdir(), "matrix-deps-cache-"));
    const setup = dependencySetup({ sandbox, cacheRoot, policy: () => ({}) });
    const first = await worktree(files);
    expect((await setup(context(first), "checks")).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      workdir: join(first, "app"),
      cmd: ["npm", "ci", "--no-audit", "--no-fund", "--ignore-scripts"],
      network: "allowlist",
      allowHosts: ["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com"],
    });
    // The implement stage installs but never feeds the cache (its tree is not cleaned).
    const implement = await worktree({ ...files, "app/package-lock.json": '{"v":0}' });
    await setup(context(implement), "implement");
    await setup(context(implement), "implement");
    expect(calls).toHaveLength(3);
    calls.splice(1);
    const second = await worktree(files);
    const restored = await setup(context(second), "checks");
    expect(restored.receipts[0]?.summary).toContain("restored from cache");
    expect(calls).toHaveLength(1);
    expect(await readFile(join(second, "app/node_modules/.bin/tsc"), "utf8")).toBe("installed");
    // A changed lockfile is a different cache entry: install again.
    const third = await worktree({ ...files, "app/package-lock.json": '{"v":2}' });
    await setup(context(third), "checks");
    expect(calls).toHaveLength(2);
  });

  test("a failed install fails setup; no policy means no setup", async () => {
    const sandbox = {
      kind: "podman" as const,
      exec: async () => ({ code: 1, stdout: "", stderr: "npm ERR! lockfile out of sync" }),
    };
    const cacheRoot = await mkdtemp(join(tmpdir(), "matrix-deps-cache-"));
    const dir = await worktree({ "package.json": "{}", "package-lock.json": "{}" });
    const failed = await dependencySetup({ sandbox, cacheRoot, policy: () => ({}) })(
      context(dir),
      "checks",
    );
    expect(failed.ok).toBe(false);
    expect(failed.receipts[0]?.data).toMatchObject({ output: "npm ERR! lockfile out of sync" });
    const none = await dependencySetup({ sandbox, cacheRoot, policy: () => undefined })(
      context(dir),
      "checks",
    );
    expect(none).toMatchObject({ ok: true, receipts: [] });
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });

  test("explicit steps run as given; a missing cwd fails without running", async () => {
    const calls: SandboxExecSpec[] = [];
    const sandbox = {
      kind: "podman" as const,
      exec: async (spec: SandboxExecSpec) => {
        calls.push(spec);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const cacheRoot = await mkdtemp(join(tmpdir(), "matrix-deps-cache-"));
    const dir = await worktree({ "app/package.json": "{}" });
    const steps = [{ cwd: "app", run: ["npm", "install"] }];
    expect(
      (
        await dependencySetup({ sandbox, cacheRoot, policy: () => ({ steps }) })(
          context(dir),
          "checks",
        )
      ).ok,
    ).toBe(true);
    expect(calls[0]?.cmd).toEqual(["npm", "install"]);
    const missing = [{ cwd: "nope", run: ["npm", "ci"] }];
    const result = await dependencySetup({
      sandbox,
      cacheRoot,
      policy: () => ({ steps: missing }),
    })(context(dir), "checks");
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("cache restore", () => {
  test("a failed restore leaves no partial node_modules behind", async () => {
    const entry = await worktree({ "manifest.json": '["app/node_modules"]', "0/x": "cached" });
    const dir = await worktree({ "app/package.json": "{}", "app/node_modules/stale": "planted" });
    const failingCopy = async (_from: string, to: string) => {
      await mkdir(to, { recursive: true });
      await writeFile(join(to, "partial"), "half");
      throw new Error("entry pruned mid-copy");
    };
    await expect(restoreInstall(entry, dir, failingCopy)).rejects.toThrow("pruned");
    expect(existsSync(join(dir, "app/node_modules"))).toBe(false);
    expect(await restoreInstall(join(entry, "missing"), dir)).toBe(false);
  });
});
