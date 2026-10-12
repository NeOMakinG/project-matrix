import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, reviewReceipt } from "@matrix/core";
import { describe, expect, test } from "vitest";
import { decide, evaluateCandidate, type ReplayExecutor } from "./evaluate.js";
import { extractLessons } from "./extract.js";
import { LessonStore, PromotionError } from "./lesson-store.js";
import { materialize } from "./materialize.js";
import { cluster, proposeCandidates } from "./propose.js";
import type { Candidate, Metrics, RawLesson } from "./types.js";

const fixedNow = () => new Date("2026-10-12T10:00:00Z");

async function seededStore() {
  const store = new MemoryStore();
  const base = { projectId: "p1", ticketId: "T-1", host: "h", attempt: 1, lastEventAt: new Date() };
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

const m = (p1Caught: number, holdout: number, cost = 0.1): Metrics => ({
  loopbacks: 0,
  p1Caught,
  p1Expected: 1,
  holdoutSatisfaction: holdout,
  costUsd: cost,
});

describe("decide", () => {
  test("needs enough samples", () => {
    expect(decide(m(0, 0.5), m(3, 1), 2).decision).toBe("shadow");
  });
  test("promotes clear wins, rejects regressions", () => {
    expect(decide(m(1, 0.8), m(3, 0.9), 3).decision).toBe("promote");
    expect(decide(m(3, 0.9), m(1, 0.9), 3).decision).toBe("reject");
    expect(decide(m(3, 0.9), m(3, 0.9), 3).decision).toBe("shadow");
  });
});

describe("LessonStore + evaluation", () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "matrix-lessons-"));
    const index = new MemoryStore();
    const store = new LessonStore(root, index, fixedNow);
    const lesson: RawLesson = {
      projectId: "p1",
      ticketId: "T-1",
      source: "loopback",
      phase: "checks",
      text: "typecheck failed on optional props",
    };
    const [proposal] = await proposeCandidates([lesson]);
    const candidate = await store.upsert("p1", proposal!);
    return { root, index, store, candidate };
  }

  const executor = (gain: boolean): ReplayExecutor => ({
    async execute(_replay, candidate) {
      return candidate && gain ? m(1, 0.95, 0.12) : m(0, 0.7, 0.1);
    },
  });
  const cases = ["a", "b", "c"].map((id) => ({
    id,
    ticketId: id,
    phase: "review",
    input: "x",
    expectedP1: ["bug"],
  }));

  test("never promotes without a recorded evaluation", async () => {
    const { store, candidate } = await setup();
    await expect(store.promote(candidate.id)).rejects.toBeInstanceOf(PromotionError);
  });

  test("promotes a winning candidate and indexes every change", async () => {
    const { store, index, candidate, root } = await setup();
    const evaluation = await evaluateCandidate(candidate, cases, executor(true), { now: fixedNow });
    expect(evaluation.decision).toBe("promote");
    await store.recordEvaluation(candidate.id, evaluation);
    const promoted: Candidate = await store.promote(candidate.id);
    expect(promoted.status).toBe("promoted");
    const changes = await materialize(root, promoted);
    expect(await readFile(changes[0]!.path, "utf8")).toContain("typecheck failed");
    expect(await materialize(root, promoted)).toEqual([]);
    const indexed = await index.listLessons("p1");
    expect(indexed.map((l) => l.source.split(":").at(-1))).toEqual([
      "proposed",
      "proposed",
      "promoted",
    ]);
  });

  test("a losing candidate cannot be promoted and new evidence invalidates old evaluations", async () => {
    const { store, candidate } = await setup();
    const losing = await evaluateCandidate(candidate, cases, executor(false), { now: fixedNow });
    expect(losing.decision).not.toBe("promote");
    await store.recordEvaluation(candidate.id, losing);
    await expect(store.promote(candidate.id)).rejects.toThrow(/decided/);

    const winning = await evaluateCandidate(candidate, cases, executor(true), { now: fixedNow });
    const bumped = await store.upsert("p1", {
      title: candidate.title,
      payload: candidate.payload,
      evidence: [{ ...candidate.evidence[0]!, ticketId: "T-9" }],
    });
    expect(bumped.version).toBe(2);
    await expect(store.recordEvaluation(candidate.id, winning)).rejects.toBeInstanceOf(
      PromotionError,
    );
  });
});
