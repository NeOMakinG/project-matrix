import type { Pack } from "../types";
import { list, opt } from "./helpers";

export const designPack: Pack = {
  id: "design",
  title: "Design",
  questions: [
    {
      id: "design.componentLibrary",
      pack: "design",
      kind: "text",
      field: "design.componentLibrary",
      prompt: "Which existing component library and design system should Figma frames follow?",
      dependsOn: ["agents.designFirst"],
      when: (answers) => answers["agents.designFirst"] === true,
    },
    {
      id: "design.figmaFileUrl",
      pack: "design",
      kind: "text",
      field: "design.figmaFileUrl",
      prompt: "Existing Figma file URL for this project's designs (HTTPS file/design URL)?",
      dependsOn: ["agents.designFirst"],
      when: (answers) => answers["agents.designFirst"] === true,
    },
    {
      id: "design.artDirection",
      pack: "design",
      kind: "text",
      field: "design.artDirection",
      prompt: "Art direction in a sentence (mood, references, what it must not look like)?",
      recommended: "Clean, calm and dense; Linear-grade polish; no stock-illustration look.",
    },
    {
      id: "design.theme",
      pack: "design",
      kind: "select",
      field: "design.theme",
      prompt: "Theme?",
      recommended: "both",
      options: [opt("light", "Light"), opt("dark", "Dark"), opt("both", "Light + dark")],
    },
    {
      id: "design.brandColors",
      pack: "design",
      kind: "list",
      field: "design.brandColors",
      prompt: "Brand colours (hex, comma-separated)?",
      recommended: [],
      toValue: list,
    },
    {
      id: "design.references",
      pack: "design",
      kind: "list",
      field: "design.references",
      prompt: "Reference products or URLs (comma-separated)?",
      recommended: [],
      toValue: list,
    },
  ],
};
