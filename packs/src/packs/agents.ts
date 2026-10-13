import { recommendedModels } from "@matrix/config";
import type { Pack } from "../types";
import { includes, list, opt } from "./helpers";

export const agentsPack: Pack = {
  id: "agents",
  title: "Agent capabilities",
  questions: [
    {
      id: "models.plan",
      pack: "agents",
      kind: "text",
      field: "models",
      prompt: "Model plan (JSON): tiers.large/small and per-phase runner/model defaults?",
      recommended: JSON.stringify(recommendedModels),
      rationale:
        "Opus 5.5 for large tasks, Sonnet 5.5 for small tasks, and Codex gpt-6-sol for independent review.",
      toValue: (value) => JSON.parse(String(value)),
    },
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
      id: "agents.browserDriver",
      pack: "agents",
      kind: "select",
      field: "agents.browserDriver",
      prompt: "Which browser driver do agents use?",
      dependsOn: ["agents.browserControl", "agents.workspace"],
      when: (a) => a["agents.browserControl"] === true,
      recommended: (a) => (a["agents.workspace"] === "native" ? "playwright" : "orca-browser"),
      rationale:
        "Orca's built-in browser lets you watch and take over; Playwright is the headless, CI-reproducible fallback.",
      options: [
        opt("orca-browser", "Orca browser", "Visible in Orca, shares the run's worktree."),
        opt("agent-browser", "agent-browser", "CDP-driven, attaches to a real Chrome profile."),
        opt("playwright", "Playwright", "Headless, scripted, runs in CI and containers."),
      ],
      adr: {
        topic: "agent browser control",
        context:
          "Browser control produces QA receipts and drives logged-in flows; it never gets production credentials.",
      },
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
      id: "agents.emulatorDriver",
      pack: "agents",
      kind: "select",
      field: "agents.emulatorDriver",
      prompt: "How do agents drive the emulators?",
      dependsOn: ["agents.emulators"],
      when: (a) => Array.isArray(a["agents.emulators"]) && a["agents.emulators"].length > 0,
      recommended: (a) => (a["mobile.qa"] === "maestro" ? "maestro" : "orca"),
      rationale: "Use the same driver as the mobile QA flows so agent receipts and CI runs match.",
      options: [
        opt("orca", "Orca emulators", "iOS simulator + Android emulator inside Orca."),
        opt("agent-device", "agent-device", "Agent exploration on a physical or remote device."),
        opt("maestro", "Maestro", "Replays committed YAML flows."),
      ],
      adr: {
        topic: "agent device control",
        context: "Mobile QA receipts come from emulators driven by agents.",
      },
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
      prompt:
        "Extra CLIs or MCP servers agents may use (e.g. higgsfield for media, appllama for app design research)?",
      recommended: [],
      rationale:
        "Every tool an agent can call is listed here and in an ADR, so reviews know what agents may touch.",
      toValue: list,
      adr: {
        topic: "extra agent tools",
        context:
          "Agents only call allow-listed tools; each needs its own scoped credential held outside the sandbox.",
      },
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
