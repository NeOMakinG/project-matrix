import type { Run, RunEvent } from "@/api/schemas";

const log: RunEvent[] = [
  {
    at: "2026-10-12T10:31:02Z",
    phase: "spike",
    message:
      "Plan: 4 steps · touches ADR-0007 (payments via Stripe), ADR-0011 (money as integer cents)",
  },
  {
    at: "2026-10-12T10:33:40Z",
    phase: "implement",
    message: "claude-fable-5-1 in container mx-run-8f3a · worktree mx-142",
  },
  {
    at: "2026-10-12T10:41:55Z",
    phase: "implement",
    message: "Edited src/billing/checkout.ts (+84 -12), src/billing/plans.ts (+31)",
  },
  {
    at: "2026-10-12T10:44:09Z",
    phase: "implement",
    message: "Added tests/billing/checkout.test.ts (9 cases)",
  },
  {
    at: "2026-10-12T10:46:30Z",
    phase: "checks",
    message: "tsc ✓  biome ✓  matrix check ✓ (14 ADR rules)  vitest 128/128 ✓",
  },
  {
    at: "2026-10-12T10:47:12Z",
    phase: "review",
    message: "4 lanes on gpt-6.1-sol: correctness, security, ADR, UX",
  },
  {
    at: "2026-10-12T10:52:48Z",
    phase: "review",
    message: "P1 0 · P2 1 (idempotency key missing on retry) → fixed in 2 commits",
  },
  {
    at: "2026-10-12T10:58:03Z",
    phase: "qa",
    message: "agent-browser: checkout annual plan, test card 4242 → success page",
  },
  {
    at: "2026-10-12T10:59:41Z",
    phase: "qa",
    message: "holdout scenarios 11/12 satisfied · 1 pending (proration upgrade)",
  },
  { at: "2026-10-12T11:00:15Z", phase: "qa", message: "Recording e2e-checkout.mp4 · 0:42" },
];

export const liveTail: RunEvent[] = [
  { at: "2026-10-12T11:01:02Z", phase: "qa", message: "curl POST /api/checkout → 200 (412 ms)" },
  { at: "2026-10-12T11:01:40Z", phase: "qa", message: "Uploading receipts to ticket MX-142" },
];

export function makeRun(): Run {
  return {
    id: "r_8f3a2c",
    projectId: "ledgerly",
    ticketId: "MX-142",
    title: "Stripe checkout for annual plans",
    startedAt: "2026-10-12T10:31:02Z",
    status: "running",
    phases: [
      { phase: "spike", state: "done" },
      { phase: "implement", state: "done" },
      { phase: "checks", state: "done" },
      { phase: "review", state: "done" },
      { phase: "qa", state: "active" },
      { phase: "merge", state: "pending" },
      { phase: "deploy", state: "pending" },
      { phase: "verify", state: "pending" },
    ],
    runners: [
      { phase: "spike", runner: "claude-code", model: "fable-5-1" },
      { phase: "implement", runner: "claude-code", model: "fable-5-1" },
      { phase: "review", runner: "codex", model: "gpt-6.1-sol" },
      { phase: "qa", runner: "agent-browser", model: "sonnet-5-5" },
    ],
    workspace: {
      kind: "orca",
      label: "orca: bosgame · wt/pilot-142",
      url: "orca://worktree/bosgame/pilot-142",
    },
    costUsd: 4.12,
    tokens: 412_000,
    log,
    findings: [
      {
        id: "f1",
        severity: "P2",
        lane: "security",
        text: "Retry path re-creates the Stripe session without an idempotency key",
        resolution: "fixed in 3c1e9a2",
      },
      {
        id: "f2",
        severity: "P3",
        lane: "ADR-0011",
        text: "Price shown with toFixed(2) on a float; use formatCents()",
        resolution: "fixed in 7b04d11",
      },
      {
        id: "f3",
        severity: "P3",
        lane: "UX",
        text: "Annual toggle has no saving hint (-2 months)",
        resolution: "ticket MX-160",
      },
      {
        id: "f4",
        severity: "P3",
        lane: "tests",
        text: "Missing test for currency mismatch",
        resolution: "accepted",
      },
    ],
    receipts: [
      { kind: "screenshot", label: "plans.png", ok: true },
      { kind: "screenshot", label: "checkout.png", ok: true },
      { kind: "screenshot", label: "success.png", ok: true },
      { kind: "video", label: "e2e-checkout.mp4 · 0:42", ok: true },
      { kind: "curl", label: "curl POST /api/checkout 200", ok: true },
      { kind: "test", label: "vitest 128/128", ok: true },
    ],
    receiptsExpected: 6,
    holdout: {
      satisfied: 11,
      total: 12,
      score: 0.92,
      judge: "opus-5-5",
      pending: "Pending: upgrade monthly → annual mid-cycle prorates correctly",
    },
    merge: {
      mode: "human merge",
      note: "Autonomy for ledgerly requires your approval after QA passes. Change it in Settings.",
      decision: "pending",
    },
    pullRequest: { number: 58, url: "https://github.com/NeOMakinG/ledgerly/pull/58" },
  };
}
