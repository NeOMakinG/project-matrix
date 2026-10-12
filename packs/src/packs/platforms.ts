import type { Pack } from "../types";
import { opt } from "./helpers";

export const platformsPack: Pack = {
  id: "platforms",
  title: "Platforms",
  questions: [
    {
      id: "platforms.targets",
      pack: "platforms",
      kind: "multiselect",
      field: "platforms",
      prompt: "Which platforms ship first?",
      recommended: ["web"],
      rationale: "Start with one platform; the factory adds Expo and Tauri packs later.",
      options: [
        opt("web", "Web"),
        opt("ios", "iOS"),
        opt("android", "Android"),
        opt("desktop", "Desktop (Tauri)"),
        opt("cli", "CLI"),
        opt("api-only", "API only"),
      ],
      infer: (ctx) => {
        const found: string[] = [];
        if (ctx.dependencies.has("react-dom") || ctx.dependencies.has("next")) found.push("web");
        if (ctx.dependencies.has("expo")) found.push("ios", "android");
        if (ctx.dependencies.has("@tauri-apps/api")) found.push("desktop");
        return found.length > 0 ? found : undefined;
      },
      adr: {
        topic: "target platforms",
        context: "Platforms decide the stack packs, QA devices and release process.",
      },
    },
  ],
};
