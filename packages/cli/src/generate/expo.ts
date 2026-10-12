import type { MatrixConfig } from "@matrix/config";
import type { Files } from "./docs";
import { jsxText } from "./escape";
import { expoSdk, versions } from "./versions";

type Mobile = NonNullable<MatrixConfig["mobile"]>;

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const sdk = (names: string[]) => Object.fromEntries(names.map((n) => [n, expoSdk[n] ?? "latest"]));
const npm = (names: string[]) => Object.fromEntries(names.map((n) => [n, versions[n] ?? "latest"]));

/** Reverse-DNS app id from the package name, e.g. com.ledgerly.app. */
const appId = (pkg: string) => `com.${pkg.replace(/[^a-z0-9]/g, "") || "matrix"}.app`;

/** Expo (expo-router) app in apps/mobile. */
export function expoFiles(c: MatrixConfig, m: Mobile, pkg: string): Files {
  const nativewind = m.styling === "nativewind";
  const query = m.data === "tanstack-query";
  const deps = {
    ...sdk([
      "expo",
      "expo-router",
      "expo-status-bar",
      "expo-linking",
      "expo-constants",
      "react",
      "react-dom",
      "react-native",
      "react-native-safe-area-context",
      "react-native-screens",
      "react-native-web",
      ...(nativewind ? ["react-native-reanimated", "react-native-worklets"] : []),
      ...(m.updates === "eas-update" ? ["expo-updates"] : []),
    ]),
    ...npm([
      "zod",
      ...(query ? ["@tanstack/react-query"] : []),
      ...(nativewind ? ["nativewind"] : []),
    ]),
    ...(m.styling === "tamagui" ? npm(["tamagui"]) : {}),
  };
  const devDeps = {
    ...sdk(["@types/react", ...(nativewind ? ["tailwindcss"] : [])]),
    typescript: versions.typescript ?? "^5.9.0",
  };

  const name = c.business.name;
  const files: Files = {
    "apps/mobile/package.json": json({
      name: `${pkg}-mobile`,
      private: true,
      main: "expo-router/entry",
      scripts: {
        start: "expo start",
        android: "expo start --android",
        ios: "expo start --ios",
        typecheck: "tsc -p tsconfig.json --noEmit",
        "expo:check": "expo install --check",
        test: "echo 'mobile flows run with Maestro (see .maestro/)'",
      },
      dependencies: deps,
      devDependencies: devDeps,
    }),
    "apps/mobile/app.json": json({
      expo: {
        name,
        slug: pkg,
        scheme: pkg,
        version: "0.1.0",
        orientation: "portrait",
        userInterfaceStyle: c.design.theme === "both" ? "automatic" : c.design.theme,
        newArchEnabled: true,
        ios: { bundleIdentifier: appId(pkg), supportsTablet: true },
        android: { package: appId(pkg) },
        plugins: ["expo-router"],
        experiments: { typedRoutes: true },
      },
    }),
    "apps/mobile/tsconfig.json": json({
      extends: "expo/tsconfig.base",
      compilerOptions: { strict: true, noUncheckedIndexedAccess: true },
      include: ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"],
    }),
    "apps/mobile/expo-env.d.ts": '/// <reference types="expo/types" />\n',
    "apps/mobile/app/_layout.tsx": `${query ? 'import { QueryClient, QueryClientProvider } from "@tanstack/react-query";\n' : ""}import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";${query ? '\nimport { useState } from "react";' : ""}${nativewind ? '\nimport "../global.css";' : ""}

export default function RootLayout() {${query ? "\n  const [client] = useState(() => new QueryClient());" : ""}
  return (
    ${query ? "<QueryClientProvider client={client}>" : "<>"}
      <Stack />
      <StatusBar style="auto" />
    ${query ? "</QueryClientProvider>" : "</>"}
  );
}
`,
    "apps/mobile/app/index.tsx": nativewind
      ? `import { Text, View } from "react-native";

export default function Home() {
  return (
    <View className="flex-1 items-center justify-center p-6">
      <Text className="text-2xl font-bold">${jsxText(name)}</Text>
      <Text className="mt-2 text-center">${jsxText(c.business.valueProposition)}</Text>
    </View>
  );
}
`
      : `import { StyleSheet, Text, View } from "react-native";

export default function Home() {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>${jsxText(name)}</Text>
      <Text style={styles.body}>${jsxText(c.business.valueProposition)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { fontSize: 24, fontWeight: "700" },
  body: { marginTop: 8, textAlign: "center" },
});
`,
    "apps/mobile/.maestro/smoke.yaml": `appId: ${appId(pkg)}
---
- launchApp
- assertVisible:
    text: ${JSON.stringify(name)}
`,
    "apps/mobile/.gitignore": ".expo/\nios/\nandroid/\nnode_modules/\n",
  };

  if (nativewind) {
    files["apps/mobile/global.css"] =
      "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n";
    files["apps/mobile/tailwind.config.js"] = `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: { extend: {} },
};
`;
    files["apps/mobile/babel.config.js"] = `module.exports = (api) => {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }], "nativewind/babel"],
  };
};
`;
    files["apps/mobile/metro.config.js"] =
      `const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

module.exports = withNativeWind(getDefaultConfig(__dirname), { input: "./global.css" });
`;
    files["apps/mobile/nativewind-env.d.ts"] = '/// <reference types="nativewind/types" />\n';
  }

  if (m.builds === "eas")
    files["apps/mobile/eas.json"] = json({
      cli: { appVersionSource: "remote" },
      build: {
        development: { developmentClient: true, distribution: "internal" },
        preview: { distribution: "internal" },
        production: { autoIncrement: true },
      },
      submit: { production: {} },
    });
  return files;
}
