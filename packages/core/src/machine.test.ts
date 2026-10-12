import { describe, expect, test } from "vitest";
import { advance, approve, backoffMs, initialState, reject, requiresApproval } from "./machine.js";
import type { Phase, Receipt } from "./ports.js";
import { testProject } from "./testing/fakes.js";
import type { PhaseOutcome, WorkflowState } from "./types.js";

const backoff = { baseMs: 1000, maxMs: 60_000 };
const now = new Date("2026-10-12T10:00:00Z");
const ok = (receipts: Receipt[] = []): PhaseOutcome => ({
  ok: true,
  summary: "ok",
  receipts,
  runStatus: "ok",
});
const at = (phase: Phase, extra: Partial<WorkflowState> = {}): WorkflowState => ({
  ...initialState("pilot", "T-1"),
  phase,
  status: "running",
  ...extra,
});
const review = (sev: "P1" | "P2"): Receipt => ({
  kind: "review",
  ok: sev !== "P1",
  summary: "lane",
  data: { lane: "correctness-security", findings: [{ severity: sev, title: "x" }] },
});
const holdout = (satisfaction: number): Receipt => ({
  kind: "holdout",
  ok: true,
  summary: "h",
  data: { satisfaction },
});

describe("advance", () => {
  const cfg = testProject();

  test("happy path walks every phase to done", () => {
    let w = at("spike");
    const outcomes: Record<Phase, PhaseOutcome> = {
      spike: ok(),
      implement: { ...ok(), model: "fable-5-1" },
      checks: ok([
        { kind: "typecheck", ok: true, summary: "" },
        { kind: "test", ok: true, summary: "" },
      ]),
      review: ok([review("P2")]),
      qa: ok([{ kind: "screenshot", ok: true, summary: "" }, holdout(0.9)]),
      merge: ok(),
      deploy: ok(),
      verify: ok(),
      compound: ok(),
    };
    const seen: Phase[] = [];
    for (let i = 0; i < 9; i++) {
      seen.push(w.phase);
      const t = advance(w, outcomes[w.phase], cfg, backoff, now);
      w = { ...t.state, status: t.state.status === "pending" ? "running" : t.state.status };
    }
    expect(seen).toEqual([
      "spike",
      "implement",
      "checks",
      "review",
      "qa",
      "merge",
      "deploy",
      "verify",
      "compound",
    ]);
    expect(w.status).toBe("done");
    expect(w.implementerModel).toBe("fable-5-1");
  });

  test("failed checks loop back to implement with the reason", () => {
    const t = advance(
      at("checks"),
      ok([{ kind: "test", ok: false, summary: "" }]),
      cfg,
      backoff,
      now,
    );
    expect(t.state.phase).toBe("implement");
    expect(t.state.loops).toBe(1);
    expect(t.state.lastError).toContain("test");
  });

  test("checks with no receipts never pass", () => {
    expect(advance(at("checks"), ok([]), cfg, backoff, now).state.phase).toBe("implement");
  });

  test("any P1 review finding loops back; P2 passes", () => {
    expect(advance(at("review"), ok([review("P1")]), cfg, backoff, now).state.phase).toBe(
      "implement",
    );
    expect(advance(at("review"), ok([review("P2")]), cfg, backoff, now).state.phase).toBe("qa");
  });

  test("QA needs evidence and a holdout score above threshold", () => {
    const shot: Receipt = { kind: "screenshot", ok: true, summary: "" };
    expect(advance(at("qa"), ok([shot]), cfg, backoff, now).state.phase).toBe("implement");
    expect(advance(at("qa"), ok([shot, holdout(0.5)]), cfg, backoff, now).state.phase).toBe(
      "implement",
    );
    expect(advance(at("qa"), ok([holdout(1)]), cfg, backoff, now).state.phase).toBe("implement");
    expect(advance(at("qa"), ok([shot, holdout(0.8)]), cfg, backoff, now).state.phase).toBe(
      "merge",
    );
  });

  test("loop limit blocks the ticket", () => {
    const t = advance(at("checks", { loops: 3 }), ok([]), cfg, backoff, now);
    expect(t.state.status).toBe("blocked");
    expect(t.effects[0]?.type).toBe("blocked");
  });

  test("crashed runs retry with exponential back-off, then block", () => {
    const crash: PhaseOutcome = { ok: false, summary: "boom", receipts: [], runStatus: "failed" };
    const first = advance(at("implement"), crash, cfg, backoff, now);
    expect(first.state).toMatchObject({ phase: "implement", status: "pending", attempt: 1 });
    expect(first.state.nextAttemptAt?.getTime()).toBe(now.getTime() + 1000);
    const second = advance({ ...first.state, status: "running" }, crash, cfg, backoff, now);
    expect(second.state.nextAttemptAt?.getTime()).toBe(now.getTime() + 2000);
    const last = advance(at("implement", { attempt: 2 }), crash, cfg, backoff, now);
    expect(last.state.status).toBe("blocked");
  });

  test("backoff is capped", () => {
    expect(backoffMs(20, backoff)).toBe(60_000);
  });
});

describe("autonomy", () => {
  test("approval rules per mode", () => {
    expect(requiresApproval("human", "merge")).toBe(true);
    expect(requiresApproval("human", "deploy")).toBe(true);
    expect(requiresApproval("gated", "merge")).toBe(false);
    expect(requiresApproval("gated", "deploy")).toBe(true);
    expect(requiresApproval("autonomous", "deploy")).toBe(false);
  });

  test("human mode waits for approval before merge", () => {
    const cfg = testProject({ autonomy: { default: "human" } });
    const shot: Receipt = { kind: "screenshot", ok: true, summary: "" };
    const t = advance(at("qa"), ok([shot, holdout(1)]), cfg, backoff, now);
    expect(t.state).toMatchObject({ phase: "merge", status: "waiting_approval" });
    expect(t.effects).toEqual([{ type: "request_approval", phase: "merge" }]);
    expect(approve(t.state).status).toBe("pending");
  });

  test("per-phase override beats the default", () => {
    const cfg = testProject({ autonomy: { default: "human", merge: "autonomous" } });
    const t = advance(
      at("verify", { phase: "qa" }),
      ok([{ kind: "screenshot", ok: true, summary: "" }, holdout(1)]),
      cfg,
      backoff,
      now,
    );
    expect(t.state).toMatchObject({ phase: "merge", status: "pending" });
  });

  test("rejection loops back to implement", () => {
    const cfg = testProject();
    const t = reject(at("merge", { status: "waiting_approval" }), cfg, "wrong copy");
    expect(t.state).toMatchObject({
      phase: "implement",
      loops: 1,
      lastError: "rejected: wrong copy",
    });
  });
});
