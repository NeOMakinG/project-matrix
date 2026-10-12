import type { Pack } from "../types";
import { includes, list, opt } from "./helpers";

export const agentsPack: Pack = {
  id: "agents",
  title: "Agent capabilities",
  questions: [
    {
      id: "agents.browserControl",
      pack: "agents",
      kind: "confirm",
      field: "agents.browserControl",
      prompt: "May agents control a browser (QA receipts, research, logged-in flows)?",
      recommended: true,
      rationale: "Web QA needs screenshots and videos from a real browser.",
    },
    {
      id: "agents.emulators",
      pack: "agents",
      kind: "multiselect",
      field: "agents.emulators",
      prompt: "Which device emulators may agents use?",
      dependsOn: ["platforms.targets"],
      when: (a) =>
        includes(a, "platforms.targets", "ios") || includes(a, "platforms.targets", "android"),
      recommended: (a) => ["android", "ios"].filter((p) => includes(a, "platforms.targets", p)),
      options: [opt("android", "Android emulator / device"), opt("ios", "iOS simulator")],
    },
    {
      id: "agents.figmaMcp",
      pack: "agents",
      kind: "confirm",
      field: "agents.figmaMcp",
      prompt: "Use the Figma MCP so agents read and write designs?",
      recommended: true,
    },
    {
      id: "agents.designFirst",
      pack: "agents",
      kind: "confirm",
      field: "agents.designFirst",
      prompt: "Design screens in Figma before implementing UI tickets?",
      dependsOn: ["agents.figmaMcp"],
      when: (a) => a["agents.figmaMcp"] === true,
      recommended: true,
      rationale: "A design pass catches UX issues before code exists.",
      adr: {
        topic: "design-first workflow",
        context: "UI tickets get a design step before implementation.",
      },
    },
    {
      id: "agents.extraClis",
      pack: "agents",
      kind: "list",
      field: "agents.extraClis",
      prompt: "Extra CLIs or MCP servers agents may use (e.g. higgsfield, appllama)?",
      recommended: [],
      toValue: list,
    },
    {
      id: "agents.workspace",
      pack: "agents",
      kind: "select",
      field: "agents.workspace",
      prompt: "Where do agent runs live?",
      recommended: "orca",
      rationale: "Orca shows each run as a worktree you can watch or take over.",
      options: [opt("orca", "Orca worktrees"), opt("native", "Matrix-managed containers")],
      infer: (ctx) => (ctx.env.ORCA_RUNTIME ? "orca" : undefined),
      adr: {
        topic: "agent workspace",
        context: "Runs need isolation and a place for humans to take over.",
      },
    },
  ],
};
