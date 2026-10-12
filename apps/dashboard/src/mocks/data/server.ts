import type {
  ApiKey,
  ServerAdr,
  ServerGraph,
  ServerProject,
  ServerReceipt,
  ServerRun,
  ServerTicket,
} from "@/api/view";

const T0 = "2026-10-12T09:00:00Z";

const humanMerge = { merge: "human", deploy: "human" } as const;

export const projects: ServerProject[] = [
  {
    id: "ledgerly",
    name: "ledgerly",
    description: "Invoicing for freelancers",
    workspace: "orca",
    autonomy: {
      ...humanMerge,
      spike: "autonomous",
      implement: "autonomous",
      review: "autonomous",
      qa: "autonomous",
    },
    createdAt: T0,
  },
  {
    id: "project-matrix",
    name: "project-matrix",
    description: "The factory, building itself",
    workspace: "orca",
    autonomy: humanMerge,
    createdAt: T0,
  },
  {
    id: "wayline",
    name: "wayline",
    description: "Travel journal app",
    workspace: "native",
    autonomy: humanMerge,
    createdAt: T0,
  },
];

const ticket = (
  id: string,
  title: string,
  phase: string,
  labels: string[],
  status: ServerTicket["status"] = "in_progress",
): ServerTicket => ({
  id,
  title,
  body: "",
  status,
  labels,
  deps: [],
  phase,
  createdAt: T0,
  updatedAt: T0,
});

export const tickets: ServerTicket[] = [
  ticket("MX-156", "Recurring invoices", "spike", ["feature", "billing"], "ready"),
  ticket("MX-158", "Client portal magic links", "spike", ["feature", "auth"], "ready"),
  ticket("MX-142", "Stripe checkout for annual plans", "qa", ["feature", "billing"]),
  ticket("MX-147", "Tax rates by country", "implement", ["feature", "invoicing"]),
  ticket("MX-153", "Fix: duplicate invoice on retry", "implement", ["prod-fix", "incident-41"]),
  ticket("MX-149", "CSV import for clients", "checks", ["feature", "import"]),
  ticket("MX-139", "Invoice PDF export", "review", ["feature", "pdf"], "review"),
  ticket("MX-145", "Dark mode tokens", "qa", ["chore", "design"], "qa"),
  ticket("MX-137", "Invoice PDF export (v1)", "merge", ["feature", "pdf"], "review"),
  ticket("MX-129", "Payment receipt emails", "deploy", ["feature", "email"]),
  ticket("MX-131", "Usage-based seats", "verify", ["feature", "billing"], "done"),
  ticket("MX-144", "Rename invoice states", "implement", ["bug"]),
];

const run = (
  r: Partial<ServerRun> & Pick<ServerRun, "id" | "ticketId" | "phase" | "model">,
): ServerRun => ({
  projectId: "ledgerly",
  startedBy: "reconciler",
  state: "running",
  runner: "claude-code",
  startedAt: "2026-10-12T10:00:00Z",
  updatedAt: "2026-10-12T11:00:00Z",
  costUsd: 1,
  ...r,
});

export const runs: ServerRun[] = [
  run({
    id: "r_8f3a2c",
    ticketId: "MX-142",
    phase: "qa",
    model: "claude-fable-5-1",
    runner: "agent-browser",
    costUsd: 4.12,
    startedAt: "2026-10-12T10:31:02Z",
    headSha: "3c1e9a2f6b",
    workspaceUrl: "orca://worktree/bosgame/pilot-142",
  }),
  run({
    id: "r_6c1d90",
    ticketId: "MX-139",
    phase: "review",
    model: "gpt-6.1-sol",
    runner: "codex",
    costUsd: 2.87,
    startedAt: "2026-10-12T09:58:40Z",
    headSha: "9ab01cd",
  }),
  run({
    id: "r_9a0f55",
    ticketId: "MX-147",
    phase: "implement",
    model: "claude-opus-5-5",
    costUsd: 3.3,
    startedAt: "2026-10-12T10:20:55Z",
  }),
  run({
    id: "r_4e8c31",
    ticketId: "MX-153",
    phase: "implement",
    model: "claude-fable-5-1",
    costUsd: 0.61,
    startedAt: "2026-10-12T10:44:09Z",
  }),
  run({
    id: "r_1a9b77",
    ticketId: "MX-131",
    phase: "verify",
    model: "claude-fable-5-1",
    costUsd: 6.4,
    state: "done",
    startedAt: "2026-10-12T06:02:30Z",
  }),
  run({
    id: "r_bad",
    ticketId: "MX-144",
    phase: "implement",
    model: "codex",
    costUsd: 0.2,
    startedAt: "2026-10-12T08:00:00Z",
    workspaceUrl: "javascript:alert(1)",
  }),
];

export const receiptsByRun: Record<string, ServerReceipt[]> = {
  r_8f3a2c: [
    {
      kind: "review",
      ok: true,
      summary: "Retry path re-creates the Stripe session without an idempotency key",
      data: { severity: "P2", lane: "security", resolution: "fixed in 3c1e9a2" },
    },
    {
      kind: "review",
      ok: true,
      summary: "Price shown with toFixed(2) on a float; use formatCents()",
      data: { severity: "P3", lane: "ADR-0011", resolution: "fixed in 7b04d11" },
    },
    {
      kind: "review",
      ok: true,
      summary: "Missing test for currency mismatch",
      data: { severity: "P3", lane: "tests", resolution: "accepted" },
    },
    {
      kind: "holdout",
      ok: true,
      summary: "holdout",
      data: {
        satisfied: 11,
        total: 12,
        score: 0.92,
        judge: "opus-5-5",
        pending: "Pending: upgrade monthly → annual mid-cycle prorates correctly",
      },
    },
    {
      kind: "screenshot",
      ok: true,
      summary: "plans.png",
      url: "https://github.com/NeOMakinG/ledgerly/blob/qa/plans.png",
    },
    {
      kind: "screenshot",
      ok: true,
      summary: "checkout.png",
      url: "https://evil.example.com/checkout.png",
    },
    { kind: "screenshot", ok: true, summary: "success.png" },
    { kind: "video", ok: true, summary: "e2e-checkout.mp4 · 0:42" },
    { kind: "curl", ok: true, summary: "curl POST /api/checkout 200" },
    { kind: "test", ok: true, summary: "vitest 128/128" },
  ],
};

export const adrs: ServerAdr[] = [
  {
    id: "0004",
    title: "Web: React + Vite + TanStack",
    status: "accepted",
    path: "docs/adr/0004-web-stack.md",
    rules: ["web-router", "web-query"],
  },
  {
    id: "0007",
    title: "Payments via Stripe",
    status: "accepted",
    path: "docs/adr/0007-stripe.md",
    rules: ["stripe-only"],
  },
  {
    id: "0011",
    title: "Money as integer cents",
    status: "accepted",
    path: "docs/adr/0011-cents.md",
    rules: ["no-float-money", "format-cents"],
  },
  {
    id: "0013",
    title: "No direct DB access from UI",
    status: "accepted",
    path: "docs/adr/0013-ui-db.md",
    rules: ["dep-cruiser-ui-db"],
  },
  {
    id: "0014",
    title: "Emails via Resend",
    status: "proposed",
    path: "docs/adr/0014-resend.md",
    rules: [],
  },
];

const n = (id: string, label: string, kind: string) => ({ id, label, kind });
export const graph: ServerGraph = {
  nodes: [
    n("g1", "Get paid faster", "goal"),
    n("g2", "Win solo freelancers", "goal"),
    n("f1", "Annual billing", "feature"),
    n("f2", "Invoice PDF", "feature"),
    n("f3", "Client portal", "feature"),
    n("a7", "0007 Stripe payments", "adr"),
    n("a11", "0011 Integer cents", "adr"),
    n("t142", "MX-142 Checkout", "ticket"),
    n("t147", "MX-147 Tax rates", "ticket"),
    n("t139", "MX-139 PDF export", "ticket"),
    n("m1", "src/billing", "module"),
    n("m2", "src/invoices", "module"),
    n("m3", "src/portal", "module"),
  ],
  edges: [
    ["g1", "f1"],
    ["g2", "f2"],
    ["g2", "f3"],
    ["f1", "a7"],
    ["f1", "a11"],
    ["f2", "a11"],
    ["a7", "t142"],
    ["a11", "t142"],
    ["a11", "t147"],
    ["f3", "t139"],
    ["t142", "m1"],
    ["t147", "m2"],
    ["t139", "m2"],
    ["t139", "m3"],
    ["t139", "missing-node"],
  ].map(([from, to]) => ({ from: from as string, to: to as string, kind: "relates" })),
};

export const apiKeys: ApiKey[] = [
  {
    id: "k1",
    name: "laptop claude-code",
    kind: "agent",
    scope: { projects: ["ledgerly"], actions: ["read", "tickets:write", "runs:start"] },
    budget: { runsPerDay: 20 },
    ratePerMinute: 60,
    createdAt: T0,
  },
  {
    id: "k2",
    name: "hermes (bosgame)",
    kind: "agent",
    scope: { projects: "*", actions: ["read", "tickets:write"] },
    budget: {},
    ratePerMinute: 30,
    createdAt: T0,
  },
  {
    id: "k3",
    name: "old desktop",
    kind: "human",
    scope: { projects: "*", actions: ["read"] },
    budget: {},
    ratePerMinute: 30,
    createdAt: T0,
    revokedAt: T0,
  },
];
