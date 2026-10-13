// Defaults name only tool-owned directories. Generic names like dist/ or build/ can hold authored
// source (src/build/...), so projects must declare those explicitly in their trusted config.
export const stackDisposableArtifacts = {
  node: ["**/node_modules/", "**/coverage/", "**/.turbo/", "**/*.tsbuildinfo"],
  next: ["**/.next/"],
  expo: ["**/.expo/", "**/android/app/build/", "**/ios/Pods/"],
} as const;
