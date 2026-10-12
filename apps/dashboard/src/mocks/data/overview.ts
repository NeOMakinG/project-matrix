import type { Gateway, Overview } from "@/api/contracts";

const projects: Overview["projects"] = [
  {
    id: "ledgerly",
    name: "ledgerly",
    kind: "web + API · pilot",
    summary: "14 open · 3 in QA",
    status: { label: "healthy", tone: "green" },
  },
  {
    id: "project-matrix",
    name: "project-matrix",
    kind: "self-hosted factory",
    summary: "22 open · 1 in review",
    status: { label: "healthy", tone: "green" },
  },
  {
    id: "wayline",
    name: "wayline",
    kind: "Expo app · onboarding",
    summary: "paused",
    status: { label: "paused", tone: "neutral" },
  },
];

export const overview: Overview = {
  host: "bosgame",
  stats: {
    activeRuns: 7,
    activeBreakdown: "3 implementing · 2 QA · 2 review",
    queue: 12,
    queueBreakdown: "4 ready · 8 blocked by deps",
    costToday: 38.4,
    budget: 120,
    openIncidents: 2,
    incidentBreakdown: "1 auto-fixing · 1 needs triage",
  },
  activeRuns: [
    {
      id: "r_8f3a2c",
      ticketId: "MX-142",
      title: "Stripe checkout",
      phase: "implement",
      model: "fable-5-1",
      costUsd: 4.12,
      status: { label: "implementing", tone: "blue" },
      projectId: "ledgerly",
    },
    {
      id: "r_6c1d90",
      ticketId: "MX-139",
      title: "Invoice PDF export",
      phase: "review",
      model: "gpt-6.1-sol",
      costUsd: 2.87,
      status: { label: "reviewing", tone: "violet" },
      projectId: "ledgerly",
    },
    {
      id: "r_2b7e14",
      ticketId: "MX-151",
      title: "Onboarding emails",
      phase: "qa",
      model: "agent-browser",
      costUsd: 1.04,
      status: { label: "QA running", tone: "amber" },
      projectId: "ledgerly",
    },
    {
      id: "r_9a0f55",
      ticketId: "MX-147",
      title: "Tax rates by country",
      phase: "implement",
      model: "opus-5-5",
      costUsd: 3.3,
      status: { label: "implementing", tone: "blue" },
      projectId: "ledgerly",
    },
    {
      id: "r_4e8c31",
      ticketId: "MX-153",
      title: "Fix: duplicate invoice",
      phase: "spike",
      model: "fable-5-1",
      costUsd: 0.61,
      status: { label: "prod fix", tone: "red" },
      projectId: "ledgerly",
    },
    {
      id: "r_7d2a08",
      ticketId: "PM-12",
      title: "Ticket adapter: Linear",
      phase: "implement",
      model: "codex",
      costUsd: 1.92,
      status: { label: "implementing", tone: "blue" },
      projectId: "project-matrix",
    },
  ],
  projects,
  models: [
    {
      id: "claude-fable-5-1",
      note: "sub B · 23% weekly",
      usage: 0.23,
      status: { label: "ok", tone: "green" },
    },
    {
      id: "claude-opus-5-5",
      note: "sub A · resets Oct 13 12:00",
      usage: 1,
      status: { label: "cooldown", tone: "amber" },
    },
    {
      id: "gpt-6.1-sol",
      note: "reviews · 41% daily",
      usage: 0.41,
      status: { label: "ok", tone: "green" },
    },
    {
      id: "GLM-5.3",
      note: "research · 429 backoff 90s",
      usage: 0.92,
      status: { label: "throttled", tone: "red" },
    },
    {
      id: "qwen3.6-35b",
      note: "bosgame local",
      usage: 0.12,
      status: { label: "ok", tone: "green" },
    },
  ],
  orca: {
    status: { label: "healthy", tone: "green" },
    host: "bosgame · orca serve v1.4.2",
    worktrees: "6 active · 2 idle",
    decisionGates: "1 waiting (MX-139 merge)",
  },
  alerts: [
    {
      kind: { label: "incident", tone: "red" },
      message: "ledgerly · duplicate invoice on retry · fix ticket MX-153",
    },
    {
      kind: { label: "stalled", tone: "amber" },
      message: "MX-133 implement idle 22 min · restarted with back-off",
    },
    {
      kind: { label: "approval", tone: "blue" },
      message: "MX-139 ready to merge · waiting for you",
    },
  ],
};

export const gateway: Gateway = { address: "miniforum:8317", healthy: 4, total: 5 };
