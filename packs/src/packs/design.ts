import type { Pack } from "../types";
import { list, opt } from "./helpers";

export const designPack: Pack = {
  id: "design",
  title: "Design",
  questions: [
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
