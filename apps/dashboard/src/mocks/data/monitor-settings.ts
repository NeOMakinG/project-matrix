import type { Verification } from "@/api/contracts";
import type { Integration } from "@/api/view";

export const verification: Verification = {
  deploy: "d-118",
  ago: "2h ago",
  series: [1.6, 1.75, 1.9, 1.72, 1.85, 1.8, 1.2, 0.62, 0.5, 0.46, 0.44, 0.42],
  deployIndex: 5.4,
  rows: [
    { label: "Error rate", value: { label: "1.9% → 0.42%", tone: "green" } },
    { label: "Fix ticket", value: { label: "MX-150 verified · closed", tone: "green" } },
  ],
};

export const integrations: Integration[] = [
  {
    name: "Tickets",
    detail: "beads · .beads/ in repo · adapter: beads",
    status: { label: "connected", tone: "green" },
  },
  {
    name: "Orca",
    detail: "runtime bosgame · orca serve v1.4.2 · workspace adapter: orca",
    status: { label: "paired", tone: "green" },
  },
  {
    name: "Sentry",
    detail: "ledgerly-web, ledgerly-api · webhook → monitor",
    status: { label: "connected", tone: "green" },
  },
  {
    name: "GitHub",
    detail: "NeOMakinG/ledgerly · draft PRs · merge queue off",
    status: { label: "connected", tone: "green" },
  },
  {
    name: "Telegram",
    detail: "alerts + approvals via Hermes gateway",
    status: { label: "approvals only", tone: "amber" },
  },
];

export function makeSettings() {
  return {
    runners: [
      { phase: "spike", runner: "claude-code", model: "claude-fable-5-1" },
      { phase: "implement", runner: "claude-code", model: "claude-fable-5-1" },
      { phase: "review", runner: "codex", model: "gpt-6.1-sol" },
      { phase: "qa", runner: "agent-browser", model: "claude-sonnet-5-5" },
    ],
    runnerOptions: ["claude-code", "codex", "opencode", "agent-browser"],
    modelOptions: [
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "gpt-6.1-sol",
      "GLM-5.3",
    ],
    budgetUsdPerDay: 120,
  };
}
