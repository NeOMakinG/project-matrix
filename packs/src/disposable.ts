const packageArtifacts = [
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".turbo/",
  "*.tsbuildinfo",
];

export function suggestDisposableArtifacts(files: Readonly<Record<string, string>>): string[] {
  const artifacts = new Set<string>();
  const add = (root: string, paths: string[]) => {
    for (const path of paths) artifacts.add(`${root}${path}`);
  };
  for (const [path, content] of Object.entries(files)) {
    if (
      /[\\\x00-\x1f\x7f*?!\[\]{}:]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      continue;
    const root = path.slice(0, path.lastIndexOf("/") + 1);
    if (path === `${root}package.json`) {
      add(root, packageArtifacts);
      try {
        const pkg = JSON.parse(content);
        const dependencies = new Set<string>();
        for (const field of [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ])
          for (const dependency of Object.keys(pkg?.[field] ?? {})) dependencies.add(dependency);
        if (dependencies.has("next")) add(root, [".next/"]);
        if (dependencies.has("expo")) add(root, [".expo/"]);
        if (dependencies.has("expo") || dependencies.has("react-native"))
          add(root, ["ios/Pods/", "android/app/build/"]);
      } catch {}
    }
    if (/^next\.config\.(?:js|cjs|mjs|ts)$/.test(path.slice(root.length))) add(root, [".next/"]);
    for (const marker of [
      "ios/Podfile",
      "android/app/build.gradle",
      "android/app/build.gradle.kts",
    ]) {
      if (path === marker || path.endsWith(`/${marker}`)) {
        const nativeRoot = path.slice(0, -marker.length);
        add(nativeRoot, [marker === "ios/Podfile" ? "ios/Pods/" : "android/app/build/"]);
      }
    }
  }
  return [...artifacts].sort();
}
