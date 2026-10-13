import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleAnswers } from "@matrix/packs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { disposablePolicy } from "../../workspace/src/artifact-policy";
import { trackedArtifactFiles } from "./disposable-artifacts";
import { runInit } from "./init";

const git = vi.hoisted(() => ({ tracked: [] as string[], available: false }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
      if (command !== "git") return actual.spawnSync(command, args, options);
      return {
        status: args[0] === "ls-files" && git.available ? 0 : 1,
        stdout: args[0] === "ls-files" ? git.tracked.map((path) => `${path}\0`).join("") : "",
        stderr: "",
        pid: 0,
        signal: null,
        output: [],
      };
    },
  };
});

const roots: string[] = [];
async function fresh() {
  const root = await mkdtemp(join(tmpdir(), "matrix-init-disposable-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  git.tracked = [];
  git.available = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("init disposable declarations (Git mocked)", () => {
  test("new Expo and Next scaffolds serialize explicit package-root declarations", async () => {
    const out = await fresh();
    const result = await runInit({
      answers: {
        ...sampleAnswers,
        "platforms.targets": ["web", "ios", "android"],
        "frontend.bundler": "next",
      },
      outDir: out,
      acceptRecommended: true,
      scaffold: true,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const paths = result.config.process.disposableArtifacts;
    expect(paths).toEqual(
      expect.arrayContaining([
        "node_modules/",
        "apps/web/node_modules/",
        "apps/web/.next/",
        "apps/mobile/node_modules/",
        "apps/mobile/.expo/",
        "apps/mobile/ios/Pods/",
        "apps/mobile/android/app/build/",
      ]),
    );
    expect(paths?.some((path) => path.startsWith("**/"))).toBe(false);
    const text = await readFile(join(out, "matrix.config.ts"), "utf8");
    expect(text).toMatch(/"?disposableArtifacts"?:/);
    expect(text).toContain('"apps/mobile/.expo/"');
    expect(disposablePolicy(text)("apps/mobile/.expo/state.json")).toBe(true);
    expect(disposablePolicy(text)("src/coverage/secret.ts")).toBe(false);
    expect(result.warnings).toContain(
      "Review process.disposableArtifacts in the onboarding PR before trusting the new config as BASE.",
    );
  });

  test("existing onboarding uses only tracked package and native/Next anchors", async () => {
    const out = await fresh();
    const files = {
      "package.json": "{}",
      "app/package.json": '{"dependencies":{"expo":"*"}}',
      "backend/package.json": "{}",
      "web/package.json": '{"dependencies":{"next":"*"}}',
      "native/ios/Podfile": "",
      "native/android/app/build.gradle.kts": "",
      "untracked/package.json": '{"dependencies":{"next":"*","expo":"*"}}',
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(out, path, ".."), { recursive: true });
      await writeFile(join(out, path), content);
    }
    git.available = true;
    git.tracked = Object.keys(files).filter((path) => !path.startsWith("untracked/"));
    const result = await runInit({
      answers: sampleAnswers,
      outDir: out,
      existingRepo: out,
      acceptRecommended: true,
      scaffold: false,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.config.process.disposableArtifacts).toEqual(
      expect.arrayContaining([
        "node_modules/",
        "app/node_modules/",
        "app/.expo/",
        "app/ios/Pods/",
        "app/android/app/build/",
        "backend/node_modules/",
        "web/.next/",
        "native/ios/Pods/",
        "native/android/app/build/",
      ]),
    );
    expect(
      result.config.process.disposableArtifacts?.some((path) => path.startsWith("untracked/")),
    ).toBe(false);
    expect(await readFile(join(out, "matrix.config.ts"), "utf8")).toContain('"web/.next/"');
    expect(await readFile(join(out, "app/package.json"), "utf8")).toBe(files["app/package.json"]);
  });

  test("missing Git tracking, traversal and symlink anchors cannot produce suggestions", async () => {
    const out = await fresh();
    const outside = await fresh();
    await writeFile(join(outside, "package.json"), '{"dependencies":{"expo":"*"}}');
    await mkdir(join(out, "linked"));
    await symlink(join(outside, "package.json"), join(out, "linked/package.json"));
    expect(await trackedArtifactFiles(out)).toEqual({});
    git.available = true;
    git.tracked = ["linked/package.json", "../package.json"];
    expect(await trackedArtifactFiles(await realpath(out))).toEqual({});
  });
});
