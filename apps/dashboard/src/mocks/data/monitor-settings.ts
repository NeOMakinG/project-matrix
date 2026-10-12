import type { Monitor, Settings } from "@/api/schemas";

export const monitor: Monitor = {
  environment: "Production · ledgerly.app · last deploy 2h ago",
  connected: { label: "Sentry + PostHog connected", tone: "green" },
  stats: [
    { label: "Error rate (1h)", value: "0.42%", note: "was 1.9% before deploy d-118" },
    { label: "Open incidents", value: "2", note: "1 auto-fixing · 1 needs triage" },
    { label: "Auto-fixed (7d)", value: "9", note: "8 verified · 1 reverted" },
    { label: "p95 latency", value: "312ms", note: "budget 400ms" },
  ],
  incidents: [
    {
      id: "#41",
      severity: { label: "critical", tone: "red" },
      title: "Duplicate invoice on retry",
      cause: "Stripe webhook retried → createInvoice not idempotent",
      events: 214,
      users: 38,
      fixability: 0.86,
      ticket: { label: "MX-153 · implementing", tone: "blue" },
    },
    {
      id: "#43",
      severity: { label: "major", tone: "amber" },
      title: "PDF export timeout",
      cause: "Large invoices (>200 lines) exceed 10s render",
      events: 27,
      users: 6,
      fixability: 0.61,
      ticket: { label: "MX-162 · spike", tone: "violet" },
    },
    {
      id: "#42",
      severity: { label: "minor", tone: "neutral" },
      title: "Safari date picker",
      cause: "Third-party widget; no local root cause found",
      events: 9,
      users: 4,
      fixability: 0.18,
      ticket: { label: "filed for humans", tone: "neutral" },
    },
  ],
  verification: {
    deploy: "d-118",
    ago: "2h ago",
    series: [1.6, 1.75, 1.9, 1.72, 1.85, 1.8, 1.2, 0.62, 0.5, 0.46, 0.44, 0.42],
    deployIndex: 5.4,
    rows: [
      { label: "Error rate", value: { label: "1.9% → 0.42%", tone: "green" } },
      { label: "Incident #39 events", value: { label: "88 → 0 in 2h", tone: "green" } },
      { label: "Fix ticket", value: { label: "MX-150 verified · closed", tone: "green" } },
      { label: "Rollback guard", value: { label: "armed until 18:00", tone: "neutral" } },
    ],
  },
};

export function makeSettings(): Settings {
  return {
    autonomy: [
      { phase: "spike", value: "auto" },
      { phase: "implement", value: "auto" },
      { phase: "review", value: "auto" },
      { phase: "qa", value: "auto" },
      { phase: "merge", value: "human approval" },
      { phase: "deploy", value: "human approval" },
      { phase: "prod fixes", value: "auto-merge if holdout ≥ 0.9" },
    ],
    autonomyNote: "changed 3d ago by valentin",
    runners: [
      { phase: "spike", runner: "claude-code", model: "claude-fable-5-1" },
      { phase: "implement", runner: "claude-code", model: "claude-fable-5-1" },
      { phase: "review", runner: "codex", model: "gpt-6.1-sol" },
      { phase: "qa", runner: "agent-browser", model: "claude-sonnet-5-5" },
      { phase: "holdout judge", runner: "api", model: "claude-opus-5-5" },
      { phase: "research", runner: "hermes", model: "GLM-5.3" },
      { phase: "fallback", runner: "opencode", model: "qwen3.6-35b (local)" },
    ],
    runnerOptions: ["claude-code", "codex", "opencode", "agent-browser", "api", "hermes"],
    modelOptions: [
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "gpt-6.1-sol",
      "GLM-5.3",
      "qwen3.6-35b (local)",
    ],
    apiKeys: [
      {
        id: "k1",
        name: "laptop claude-code",
        prefix: "mxk_…7f2a",
        scopes: ["read", "tickets:write", "runs:start"],
        budget: "$20/day",
        status: "active",
      },
      {
        id: "k2",
        name: "hermes (bosgame)",
        prefix: "mxk_…c91e",
        scopes: ["read", "tickets:write"],
        budget: "$5/day",
        status: "active",
      },
      {
        id: "k3",
        name: "ci-bot",
        prefix: "mxk_…02bd",
        scopes: ["read", "checks:report"],
        budget: "—",
        status: "active",
      },
      {
        id: "k4",
        name: "old desktop",
        prefix: "mxk_…a4d0",
        scopes: ["read"],
        budget: "—",
        status: "revoked",
      },
    ],
    integrations: [
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
        name: "PostHog",
        detail: "EU cloud · error tracking + product events",
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
    ],
  };
}
