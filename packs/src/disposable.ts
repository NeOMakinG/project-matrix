export const stackDisposableArtifacts = {
  node: [
    "**/node_modules/",
    "**/dist/",
    "**/build/",
    "**/coverage/",
    "**/.turbo/",
    "**/*.tsbuildinfo",
  ],
  next: ["**/.next/"],
  expo: ["**/.expo/", "**/android/app/build/", "**/ios/Pods/"],
} as const;
