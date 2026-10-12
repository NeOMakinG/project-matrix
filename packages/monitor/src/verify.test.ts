import { describe, expect, test } from "vitest";
import { type Issue, MemoryIssueStore } from "./group.js";
import { verifyFix } from "./verify.js";

const issue = { fingerprint: "st:fix" } as Issue;
const deploy = "2026-10-12T12:00:00.000Z";
const opts = { beforeHours: 24, afterHours: 6, maxRatio: 0.1, floorPerHour: 0 };
const at = (h: number) => new Date(Date.parse(deploy) + h * 3_600_000).toISOString();

async function storeWith(occ: [hoursFromDeploy: number, count: number][]) {
  const store = new MemoryIssueStore();
  for (const [h, count] of occ) await store.addOccurrence(issue.fingerprint, { at: at(h), count });
  return store;
}

describe("verifyFix window math", () => {
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
      afterPerHour: 0,
      observedHours: 6,
    });
  });

  test("window not elapsed and nothing seen → pending", async () => {
    const store = await storeWith([[-2, 48]]);
    const r = await verifyFix(issue, deploy, store, at(2), opts);
    expect(r).toMatchObject({ outcome: "pending", observedHours: 2 });
  });

  test("a big drop that stays under the ratio → resolved", async () => {
    // baseline 240/24h = 10/h; allowed 1/h; after 3 in 6h = 0.5/h
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
    // allowed 1/h × 6h = 6 for the whole window; 20 in the first hour already exceeds it
    const store = await storeWith([
      [-10, 240],
      [0.5, 20],
    ]);
    const r = await verifyFix(issue, deploy, store, at(1), opts);
    expect(r.outcome).toBe("reopened");
  });

  test("no baseline: any recurrence after the window reopens, floor tolerates noise", async () => {
    const store = await storeWith([[2, 1]]);
    expect((await verifyFix(issue, deploy, store, at(6), opts)).outcome).toBe("reopened");
    const tolerant = { ...opts, floorPerHour: 0.5 };
    expect((await verifyFix(issue, deploy, store, at(6), tolerant)).outcome).toBe("resolved");
  });

  test("occurrences exactly at the deploy instant count as after", async () => {
    const store = await storeWith([[0, 5]]);
    const r = await verifyFix(issue, deploy, store, at(6), opts);
    expect(r.afterCount).toBe(5);
    expect(r.beforeCount).toBe(0);
  });
});
