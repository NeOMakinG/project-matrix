import type { Pack } from "../types";
import { opt } from "./helpers";

const autonomy = [
  opt("human", "Human approves", "Agents open draft PRs with receipts; you merge."),
  opt(
    "gated-auto",
    "Automatic after gates",
    "Merge queue merges when review, tests, QA and holdout scenarios pass.",
  ),
  opt("autonomous", "Fully autonomous", "No human step. Highest risk."),
];

export const processPack: Pack = {
  id: "process",
  title: "Process",
  questions: [
    {
      id: "process.tickets",
      pack: "process",
      kind: "select",
      field: "process.tickets",
      prompt: "Ticket system?",
      recommended: "beads",
      rationale: "beads is git-native and agent-friendly; GitHub Issues suits public projects.",
      options: [
        opt("beads", "beads"),
        opt("github", "GitHub Issues"),
        opt("linear", "Linear"),
        opt("markdown", "Markdown folder"),
      ],
      infer: (ctx) => ([...ctx.files].some((f) => f.startsWith(".beads/")) ? "beads" : undefined),
      adr: { topic: "ticket system", context: "The ticket system is the factory's control plane." },
    },
    {
      id: "process.branching",
      pack: "process",
      kind: "select",
      field: "process.branching",
      prompt: "Branching model?",
      recommended: "trunk-with-prs",
      options: [
        opt("trunk-with-prs", "Trunk + short-lived PR branches"),
        opt("gitflow", "Gitflow"),
      ],
    },
    {
      id: "process.autonomy.merge",
      pack: "process",
      kind: "select",
      field: "process.autonomy.merge",
      prompt: "Who merges agent work? (changeable later)",
      recommended: "human",
      rationale: "Start supervised; switch to gated auto-merge once the loop has earned trust.",
      options: autonomy,
      adr: {
        topic: "merge autonomy",
        context: "Autonomy is a per-project setting that can change over time.",
      },
    },
    {
      id: "process.autonomy.deploy",
      pack: "process",
      kind: "select",
      field: "process.autonomy.deploy",
      prompt: "Who triggers production deploys? (changeable later)",
      dependsOn: ["process.autonomy.merge"],
      recommended: (a) => (a["process.autonomy.merge"] === "autonomous" ? "gated-auto" : "human"),
      options: autonomy,
    },
    {
      id: "process.reviewLanes",
      pack: "process",
      kind: "multiselect",
      field: "process.reviewLanes",
      prompt: "Review lanes on every change?",
      recommended: ["correctness-security", "architecture-adr", "ux-product", "performance"],
      rationale: "Each lane runs on a different model than the implementer.",
      options: [
        opt("correctness-security", "Correctness + security"),
        opt("architecture-adr", "Architecture / ADR"),
        opt("ux-product", "UX / product"),
        opt("performance", "Performance"),
      ],
    },
    {
      id: "process.budgets.dailyUsd",
      pack: "process",
      kind: "number",
      field: "process.budgets.dailyUsd",
      prompt: "Daily model budget (USD)?",
      recommended: 50,
    },
    {
      id: "process.budgets.perTicketUsd",
      pack: "process",
      kind: "number",
      field: "process.budgets.perTicketUsd",
      prompt: "Budget per ticket (USD)?",
      recommended: 10,
    },
  ],
};
