import { MemoryStore, reviewReceipt } from "@matrix/core";
import { describe, expect, test } from "vitest";
import { decide } from "./evaluate.js";
import { extractLessons } from "./extract.js";
import { cluster, proposeCandidates } from "./propose.js";
import { metrics } from "./testkit.test-helpers.js";
import type { RawLesson } from "./types.js";

async function seededStore() {
  const store = new MemoryStore();
  const base = {
    projectId: "p1",
    ticketId: "T-1",
    host: "h",
    ownerId: "o",
    attempt: 1,
    lastEventAt: new Date(),
    heartbeatAt: new Date(),
  };
  await store.createRun({
    ...base,
    id: "r1",
    phase: "review",
    stepKey: "k1",
    status: "ok",
    startedAt: new Date(1),
  });
  await store.addReceipts("r1", [
    reviewReceipt("correctness-security", "gpt", [
      {
        severity: "P1",
        title: "Retry path re-creates checkout session without idempotency key",
        file: "src/billing/checkout.ts",
      },
      { severity: "P3", title: "Missing test for currency mismatch" },
    ]),
  ]);
  await store.createRun({
    ...base,
    id: "r2",
    phase: "implement",
    stepKey: "k2",
    status: "ok",
    startedAt: new Date(2),
  });
  await store.createRun({
    ...base,
    id: "r3",
    phase: "qa",
    stepKey: "k3",
    status: "failed",
    startedAt: new Date(3),
  });
  await store.addReceipts("r3", [
    { kind: "screenshot", ok: false, summary: "checkout page shows NaN total" },
  ]);
  await store.createRun({
    ...base,
    id: "r4",
    phase: "implement",
    stepKey: "k4",
    status: "ok",
    startedAt: new Date(4),
  });
  return store;
}

describe("extractLessons", () => {
  test("collects review findings, QA failures, loopbacks and human comments", async () => {
    const store = await seededStore();
    const lessons = await extractLessons(store, "p1", "T-1", [
      { ticketId: "T-1", text: "Use formatCents for prices", phase: "review" },
      { ticketId: "T-2", text: "other ticket" },
    ]);
    const sources = lessons.map((l) => l.source).sort();
    expect(sources).toEqual([
      "human-comment",
      "loopback",
      "loopback",
      "qa-failure",
      "review-finding",
      "review-finding",
    ]);
    const loopbacks = lessons.filter((l) => l.source === "loopback").map((l) => l.phase);
    expect(loopbacks).toEqual(["review", "qa"]);
  });
});

describe("propose", () => {
  test("clustering is order independent", () => {
    const l = (text: string): RawLesson => ({
      projectId: "p",
      ticketId: "t",
      source: "review-finding",
      phase: "review",
      text,
    });
    const a = [
      l("price uses toFixed on float"),
      l("float toFixed price rounding"),
      l("missing auth check on export"),
    ];
    expect(cluster(a)).toEqual(cluster([...a].reverse()));
    expect(cluster(a)).toHaveLength(2);
  });

  test("loopbacks become prompt patches, QA failures checklist items", async () => {
    const store = await seededStore();
    const proposals = await proposeCandidates(await extractLessons(store, "p1", "T-1"));
    const kinds = proposals.map((p) => p.payload.kind).sort();
    expect(kinds).toContain("prompt-patch");
    expect(kinds).toContain("checklist-item");
  });
});

const pair = (caseId: string, b: [number, number], c: [number, number]) => ({
  caseId,
  baseline: metrics(b[0], b[1]),
  candidate: metrics(c[0], c[1]),
});

describe("decide", () => {
  test("needs at least three cases", () => {
    expect(decide([pair("a", [0, 0.5], [1, 1]), pair("b", [0, 0.5], [1, 1])]).decision).toBe(
      "shadow",
    );
  });
  test("promotes clear wins, rejects regressions, shadows ties", () => {
    const win = ["a", "b", "c"].map((id) => pair(id, [0, 0.8], [1, 0.9]));
    expect(decide(win).decision).toBe("promote");
    const loss = ["a", "b", "c"].map((id) => pair(id, [1, 0.9], [0, 0.9]));
    expect(decide(loss).decision).toBe("reject");
    const tie = ["a", "b", "c"].map((id) => pair(id, [1, 0.9], [1, 0.9]));
    expect(decide(tie).decision).toBe("shadow");
  });
});
