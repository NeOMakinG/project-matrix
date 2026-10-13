import { describe, expect, test } from "vitest";
import { disposablePolicy } from "./artifact-policy.js";

describe("trusted BASE disposable policy (no Git)", () => {
  test("stack defaults match root and nested workspaces only", () => {
    const matches = disposablePolicy(
      'export default defineConfig({ mobile: { framework: "expo" }, frontend: { framework: "react", bundler: "next" } });',
      new Set([
        "package.json",
        "app/package.json",
        "web/package.json",
        "app/android/app/build.gradle",
        "app/ios/Podfile",
      ]),
    );
    for (const path of [
      "node_modules/pkg/index.js",
      "app/node_modules/pkg/index.js",
      "app/.expo/state.json",
      "web/.next/cache/file",
      "coverage/report",
      "app/android/app/build/output",
      "app/ios/Pods/lib/file",
      ".turbo/cache",
      "web/tsconfig.tsbuildinfo",
    ])
      expect(matches(path), path).toBe(true);
    for (const path of [
      "src/new.ts",
      "src/build/secret.ts",
      "src/coverage/secret.ts",
      "src/node_modules/hidden.ts",
      "lib/node_modules/pkg/index.js",
      "src/.turbo/cache",
      "src/project.tsbuildinfo",
      "backend/dist/api.js",
      "web/build/bundle.js",
      "src/node_modules.ts",
      "dist.ts",
      "../dist/file",
      "app/../dist/file",
      "/node_modules/pkg/index.js",
    ])
      expect(matches(path), path).toBe(false);
  });

  test("generated config supports static declarations without enabling unrelated defaults", () => {
    const matches = disposablePolicy(
      'const config = { process: { disposableArtifacts: ["cache/", "app/generated/*.js"] } } as const; export default config;',
    );
    expect(matches("cache/result")).toBe(true);
    expect(matches("app/generated/result.js")).toBe(true);
    expect(matches("nested/cache/result")).toBe(false);
    expect(matches("app/generated/deep/result.js")).toBe(false);
    expect(matches("node_modules/pkg/index.js")).toBe(false);
  });

  test.each([
    "../cache/",
    "/cache/",
    "cache/../src/",
    "cache\\file",
    "!src/",
    "cache//file",
    "./cache/",
    "cache/[ab]",
  ])("rejects unsafe or unsupported glob %s", (pattern) => {
    expect(() =>
      disposablePolicy(
        `export default { process: { disposableArtifacts: [${JSON.stringify(pattern)}] } };`,
      ),
    ).toThrow(/glob/);
  });

  test.each([
    "export default { process: { disposableArtifacts: compute() } };",
    "export default { process: { disposableArtifacts: [1] } };",
    "export default { ...other };",
    "const config = config; export default config;",
    'export default { process: {}, process: { disposableArtifacts: ["src/"] } };',
    'const config = { process: {} }; config.process.disposableArtifacts = ["src/"]; export default config;',
  ])("fails closed without evaluating config code", (source) => {
    expect(() => disposablePolicy(source)).toThrow();
  });
});
