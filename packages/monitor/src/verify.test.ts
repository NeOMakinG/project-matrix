import { describe, expect, test } from "vitest";
import { MemoryIssueStore } from "./group.js";
import { verifyFix } from "./verify.js";

const issue = { fingerprint: "st:fix" };
const deployedAt = "2026-10-12T12:00:00.000Z";
const deploy = { release: "web@1.4.1", deployedAt, olderReleases: ["web@1.3.0", "web@1.4.0"] };
const opts = {
  beforeHours: 24,
  afterHours: 6,
  maxAfterHours: 72,
  minExpected: 3,
  maxRatio: 0.1,
  floorPerHour: 0,
};
const at = (h: number) => new Date(Date.parse(deployedAt) + h * 3_600_000).toISOString();

let seq = 0;
async function storeWith(occ: [hoursFromDeploy: number, count: number, release?: string][]) {
  const store = new MemoryIssueStore();
  for (const [h, count, release] of occ) {
    await store.addOccurrence(issue.fingerprint, {
      signalId: `s${seq++}`,
      at: at(h),
      count,
      ...(release ? { release } : {}),
    });
  }
  return store;
}

describe("verifyFix", () => {
  test("48 before, 0 after over the full window → resolved", async () => {
    const store = await storeWith([
      [-20, 24],
      [-2, 24],
    ]);
    const r = await verifyFix(issue, deploy, store, at(7), opts);
    expect(r).toMatchObject({
      outcome: "resolved",
      beforeCount: 48,
      afterCount: 0,
      beforePerHour: 2,
      windowHours: 6,
      observedHours: 6,
    });
  });

  test("window not elapsed and nothing seen → pending", async () => {
    const store = await storeWith([[-2, 48]]);
    const r = await verifyFix(issue, deploy, store, at(2), opts);
    expect(r).toMatchObject({ outcome: "pending", observedHours: 2 });
  });

  test("rare error: window grows until the baseline predicts ≥ 3 occurrences", async () => {
    // 4 per day → 1/6h; 3 expected needs 18h
    const store = await storeWith([[-10, 4]]);
    expect((await verifyFix(issue, deploy, store, at(7), opts)).outcome).toBe("pending");
    const r = await verifyFix(issue, deploy, store, at(18), opts);
    expect(r).toMatchObject({ outcome: "resolved", windowHours: 18 });
  });

  test("baseline too small even at the max window → inconclusive, not resolved", async () => {
    const store = await storeWith([[-10, 1]]); // 1/day: the 72h max window predicts exactly 3
    const tiny = await storeWith([[-30, 1]]); // outside the 24h baseline: nothing to compare against
    expect((await verifyFix(issue, deploy, store, at(72), opts)).outcome).toBe("resolved");
    const r = await verifyFix(issue, deploy, tiny, at(72), opts);
    expect(r).toMatchObject({ outcome: "inconclusive", windowHours: 72 });
  });

  test("a big drop that stays under the ratio → resolved", async () => {
    const store = await storeWith([
      [-10, 240],
      [3, 3],
    ]);
    const r = await verifyFix(issue, deploy, store, at(6), opts);
    expect(r).toMatchObject({ outcome: "resolved", afterPerHour: 0.5 });
  });

  test("rate still above the allowed fraction after the window → reopened", async () => {
    const store = await storeWith([
      [-10, 240],
      [1, 12],
    ]);
    const r = await verifyFix(issue, deploy, store, at(6), opts);
    expect(r).toMatchObject({ outcome: "reopened", afterCount: 12, afterPerHour: 2 });
  });

  test("clearly back before the window ends → reopened early", async () => {
    const store = await storeWith([
      [-10, 240],
      [0.5, 20],
    ]);
    expect((await verifyFix(issue, deploy, store, at(1), opts)).outcome).toBe("reopened");
  });

  test("release-aware: stale clients on older releases don't reopen a good fix", async () => {
    const store = await storeWith([
      [-10, 240],
      [1, 50, "web@1.4.0"],
      [2, 30, "web@1.3.0"],
    ]);
    const r = await verifyFix(issue, deploy, store, at(6), opts);
    expect(r).toMatchObject({ outcome: "resolved", afterCount: 0, staleCount: 80 });
  });

  test("release-aware: the fix release itself still failing reopens; untagged counts too", async () => {
    const fixRelease = await storeWith([
      [-10, 240],
      [1, 20, "web@1.4.1"],
    ]);
    expect((await verifyFix(issue, deploy, fixRelease, at(6), opts)).outcome).toBe("reopened");
    const untagged = await storeWith([
      [-10, 240],
      [1, 20],
    ]);
    expect((await verifyFix(issue, deploy, untagged, at(6), opts)).outcome).toBe("reopened");
  });

  test("occurrences exactly at the deploy instant count as after", async () => {
    const store = await storeWith([
      [-1, 48],
      [0, 5],
    ]);
    const r = await verifyFix(issue, deploy, store, at(6), opts);
    expect(r.afterCount).toBe(5);
    expect(r.beforeCount).toBe(48);
  });
});
