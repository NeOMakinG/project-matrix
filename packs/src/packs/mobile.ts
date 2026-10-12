import type { Answers, Option, Pack, Question, RuleStub } from "../types";
import { hasMobile, opt, usesExpo } from "./helpers";

const MOBILE = ["apps/mobile/**"];

const forbid = (description: string, importRe: string): RuleStub => ({
  engine: "dependency-cruiser",
  description,
  check: { type: "forbidden-import", files: MOBILE, import: importRe },
});

interface MobileChoice {
  key: string;
  prompt: string;
  options: Option[];
  recommended: string | ((a: Answers) => string);
  rationale: string;
  topic: string;
  context: string;
  detect?: Record<string, string>;
  when?: (a: Answers) => boolean;
  dependsOn?: string[];
  rules?: (value: string) => RuleStub[];
}

const choice = (c: MobileChoice): Question => ({
  id: `mobile.${c.key}`,
  pack: "mobile",
  kind: "select",
  field: `mobile.${c.key}`,
  prompt: c.prompt,
  options: c.options,
  recommended: c.recommended,
  rationale: c.rationale,
  dependsOn: ["mobile.framework", ...(c.dependsOn ?? [])],
  when: c.when ?? usesExpo,
  ...(c.detect
    ? {
        infer: (ctx) => {
          for (const [value, pkg] of Object.entries(c.detect ?? {})) {
            if (ctx.dependencies.has(pkg) || ctx.files.has(pkg)) return value;
          }
          return undefined;
        },
      }
    : {}),
  adr: {
    topic: c.topic,
    context: c.context,
    ...(c.rules ? { rules: (v) => c.rules?.(String(v)) ?? [] } : {}),
  },
});

export const mobilePack: Pack = {
  id: "mobile",
  title: "Mobile (Expo)",
  questions: [
    {
      id: "mobile.framework",
      pack: "mobile",
      kind: "select",
      field: "mobile.framework",
      prompt: "Mobile framework?",
      dependsOn: ["platforms.targets"],
      when: hasMobile,
      recommended: "expo",
      rationale:
        "Expo ships iOS and Android from one TypeScript codebase, with managed native builds and OTA updates.",
      options: [opt("expo", "Expo (React Native)")],
      infer: (ctx) => (ctx.dependencies.has("expo") ? "expo" : undefined),
      adr: {
        topic: "mobile framework",
        context: "The mobile framework decides navigation, native builds and device QA.",
        rules: () => [
          forbid("Navigation goes through expo-router.", "^react-router(-dom|-native)?(/|$)"),
        ],
      },
    },
    choice({
      key: "data",
      prompt: "Server state on mobile?",
      options: [
        opt(
          "tanstack-query",
          "TanStack Query",
          "Caching, retries, offline mutations, focus refetch.",
        ),
        opt("none", "Plain fetch"),
      ],
      recommended: "tanstack-query",
      rationale: "Mobile networks drop; Query handles retries, caching and refetch on app focus.",
      detect: { "tanstack-query": "@tanstack/react-query" },
      topic: "mobile server state",
      context: "How the app fetches, caches and retries server data on flaky networks.",
      rules: (v) =>
        v === "tanstack-query"
          ? [forbid("Server state uses TanStack Query, not SWR.", "^swr$")]
          : [],
    }),
    choice({
      key: "styling",
      prompt: "Mobile styling?",
      options: [
        opt(
          "nativewind",
          "NativeWind",
          "Tailwind classes on React Native; shares tokens with the web.",
        ),
        opt("tamagui", "Tamagui", "Optimising compiler and a cross-platform component kit."),
        opt("stylesheet", "StyleSheet", "Built-in, zero dependencies."),
      ],
      recommended: (a) => (a["frontend.styling"] === "tailwind" ? "nativewind" : "stylesheet"),
      rationale:
        "Reuse the web's Tailwind tokens when the web uses Tailwind; otherwise stay built-in.",
      detect: { nativewind: "nativewind", tamagui: "tamagui" },
      topic: "mobile styling",
      context: "One styling system keeps the mobile UI consistent and reviewable.",
      rules: (v) =>
        v === "nativewind"
          ? [forbid("Styling uses NativeWind, not Tamagui.", "^tamagui(/|$)|^@tamagui/")]
          : v === "tamagui"
            ? [forbid("Styling uses Tamagui, not NativeWind.", "^nativewind(/|$)")]
            : [],
    }),
    choice({
      key: "builds",
      prompt: "Native builds?",
      options: [
        opt(
          "eas",
          "EAS Build + Submit",
          "Cloud builds and store submission, no local Xcode needed.",
        ),
        opt("local", "Local builds", "Xcode / Android Studio on our own machines."),
      ],
      recommended: "eas",
      rationale: "EAS builds both platforms in the cloud and submits to the stores from CI.",
      detect: { eas: "eas.json" },
      topic: "native builds and store submission",
      context: "Where iOS/Android binaries are built, signed and submitted.",
    }),
    choice({
      key: "updates",
      prompt: "Over-the-air updates?",
      options: [
        opt("eas-update", "EAS Update", "Ship JS fixes without a store review."),
        opt("none", "Store releases only"),
      ],
      recommended: (a) => (a["mobile.builds"] === "eas" ? "eas-update" : "none"),
      rationale: "OTA updates let the factory ship prod fixes to mobile in minutes.",
      dependsOn: ["mobile.builds"],
      topic: "over-the-air updates",
      context: "How JavaScript fixes reach installed apps.",
    }),
    choice({
      key: "qa",
      prompt: "Mobile QA flows?",
      options: [
        opt(
          "maestro",
          "Maestro flows",
          "YAML flows in the repo, run on any emulator incl. Orca's.",
        ),
        opt("agent-device", "agent-device", "Agent-driven exploration on real devices."),
        opt("orca", "Orca emulators", "Run and record in Orca's iOS simulator / Android emulator."),
      ],
      recommended: "maestro",
      rationale:
        "Committed Maestro flows are deterministic receipts; agents can still explore with Orca or agent-device.",
      detect: { maestro: ".maestro" },
      topic: "mobile QA",
      context: "Mobile QA receipts (screens, videos) gate merges like web QA.",
    }),
  ],
};
