import { describe, expect, test } from "vitest";
import { suggestDisposableArtifacts } from "./disposable";

describe("reviewable init disposable suggestions", () => {
  test("anchors every package and framework output to its own root", () => {
    const paths = suggestDisposableArtifacts({
      "package.json": "{}",
      "app/package.json": '{"dependencies":{"expo":"*","react-native":"*"}}',
      "backend/package.json": '{"dependencies":{"hono":"*"}}',
      "web/package.json": '{"dependencies":{"next":"*"}}',
    });
    expect(paths).toEqual(
      expect.arrayContaining([
        "node_modules/",
        "app/node_modules/",
        "app/.expo/",
        "app/ios/Pods/",
        "app/android/app/build/",
        "backend/node_modules/",
        "web/node_modules/",
        "web/.next/",
        "web/dist/",
      ]),
    );
    expect(paths).not.toContain("backend/.next/");
    expect(paths).not.toContain("web/.expo/");
    expect(paths).not.toContain("src/coverage/");
    expect(paths.some((path) => path.startsWith("**/"))).toBe(false);
    expect(paths).toEqual([...new Set(paths)].sort());
  });

  test("native and Next markers identify roots without a package manifest", () => {
    expect(
      suggestDisposableArtifacts({
        "app/ios/Podfile": "",
        "app/android/app/build.gradle": "",
        "android/app/build.gradle.kts": "",
        "web/next.config.ts": "",
      }),
    ).toEqual(["android/app/build/", "app/android/app/build/", "app/ios/Pods/", "web/.next/"]);
  });

  test("React Native and optional Next dependencies stay root-scoped", () => {
    const paths = suggestDisposableArtifacts({
      "native/package.json": '{"dependencies":{"react-native":"*"}}',
      "web/package.json": '{"optionalDependencies":{"next":"*"}}',
    });
    expect(paths).toContain("native/ios/Pods/");
    expect(paths).toContain("native/android/app/build/");
    expect(paths).not.toContain("native/.expo/");
    expect(paths).toContain("web/.next/");
  });

  test("never infers roots from authored output or unsafe filenames", () => {
    expect(
      suggestDisposableArtifacts({
        "src/coverage/secret.ts": "authored",
        "../package.json": "{}",
        "/package.json": "{}",
        "app\\package.json": "{}",
        "**/package.json": "{}",
      }),
    ).toEqual([]);
  });
});
