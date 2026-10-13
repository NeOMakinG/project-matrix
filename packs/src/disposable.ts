// A default applies only under a root whose anchor file is tracked in the trusted base commit,
// so authored folders such as src/coverage/ or src/node_modules/ never qualify.
export interface AnchoredArtifact {
  /** Directory (trailing slash) or file glob relative to the anchored root. */
  readonly path: string;
  /** Files relative to the same root; at least one must be tracked in the trusted base. */
  readonly anchors: readonly string[];
}

const packageRoot = ["package.json"] as const;

export const stackDisposableArtifacts = {
  node: [
    { path: "node_modules/", anchors: packageRoot },
    { path: "coverage/", anchors: packageRoot },
    { path: ".turbo/", anchors: packageRoot },
    { path: "*.tsbuildinfo", anchors: packageRoot },
  ],
  next: [{ path: ".next/", anchors: packageRoot }],
  expo: [
    { path: ".expo/", anchors: packageRoot },
    {
      path: "android/app/build/",
      anchors: ["android/app/build.gradle", "android/app/build.gradle.kts"],
    },
    { path: "ios/Pods/", anchors: ["ios/Podfile"] },
  ],
} as const satisfies Record<string, readonly AnchoredArtifact[]>;
