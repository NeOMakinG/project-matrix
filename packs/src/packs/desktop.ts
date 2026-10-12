import type { Pack } from "../types";
import { hasDesktop, list, opt, usesTauri } from "./helpers";

export const desktopPack: Pack = {
  id: "desktop",
  title: "Desktop (Tauri)",
  questions: [
    {
      id: "desktop.framework",
      pack: "desktop",
      kind: "select",
      field: "desktop.framework",
      prompt: "Desktop shell?",
      dependsOn: ["platforms.targets"],
      when: hasDesktop,
      recommended: "tauri",
      rationale:
        "Tauri v2 wraps the React UI in a ~10 MB native app with a Rust core and a capability-based permission model.",
      options: [opt("tauri", "Tauri v2")],
      infer: (ctx) =>
        ctx.dependencies.has("@tauri-apps/api") || ctx.files.has("src-tauri/tauri.conf.json")
          ? "tauri"
          : undefined,
      adr: {
        topic: "desktop shell",
        context: "The desktop shell decides the native boundary, permissions and release flow.",
        rules: () => [
          {
            engine: "dependency-cruiser",
            description: "The desktop app is Tauri; Electron must not come in.",
            check: {
              type: "forbidden-import",
              files: ["apps/desktop/**"],
              import: "^electron(/|$)|^@electron/",
            },
          },
          {
            engine: "custom",
            description:
              "Tauri capabilities stay explicit: no wildcard shell or filesystem permissions.",
            check: {
              type: "regex",
              files: ["apps/desktop/src-tauri/capabilities/**"],
              pattern: '"(shell|fs):allow-[a-z-]*\\*|"fs:default"|"shell:default"',
            },
          },
        ],
      },
    },
    {
      id: "desktop.updater",
      pack: "desktop",
      kind: "confirm",
      field: "desktop.updater",
      prompt: "Ship in-app auto-updates (Tauri updater plugin)?",
      dependsOn: ["desktop.framework"],
      when: usesTauri,
      recommended: true,
      rationale: "The prod-fix loop can only reach desktop users quickly with signed auto-updates.",
      adr: {
        topic: "desktop auto-updates",
        context: "Updates must be signed; the updater verifies a public key compiled into the app.",
      },
    },
    {
      id: "desktop.signing",
      pack: "desktop",
      kind: "multiselect",
      field: "desktop.signing",
      prompt: "Code-sign for which OSes (Apple notarization / Windows Authenticode)?",
      dependsOn: ["desktop.framework"],
      when: usesTauri,
      recommended: ["macos", "windows"],
      rationale:
        "Unsigned builds trigger Gatekeeper and SmartScreen warnings that kill installs; certificates take days to obtain, so decide early.",
      options: [opt("macos", "macOS (Developer ID + notarization)"), opt("windows", "Windows")],
      toValue: list,
      adr: {
        topic: "desktop code signing",
        context: "Signing identities are secrets held by CI, never by agents.",
      },
    },
    {
      id: "desktop.distribution",
      pack: "desktop",
      kind: "select",
      field: "desktop.distribution",
      prompt: "Desktop distribution?",
      dependsOn: ["desktop.framework"],
      when: usesTauri,
      recommended: "github-releases",
      rationale: "GitHub Releases hosts installers and the updater manifest for free.",
      options: [
        opt("github-releases", "GitHub Releases"),
        opt("app-stores", "Mac App Store / Microsoft Store"),
        opt("self-hosted", "Own download server"),
      ],
      adr: {
        topic: "desktop distribution",
        context: "Where installers and update manifests live.",
      },
    },
  ],
};
