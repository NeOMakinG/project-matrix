import { describe, expect, test } from "vitest";
import posthog from "./fixtures/posthog-exception.json";
import sentryEvent from "./fixtures/sentry-event.json";
import { fingerprintOf, ingest, MemoryIssueStore, normalizeTitle } from "./group.js";
import { normalize } from "./normalize/index.js";
import type { Signal } from "./signal.js";
import { raw } from "./testing.js";

const base: Signal = {
  id: "x:1",
  provider: "sentry",
  projectId: "p",
  kind: "error",
  title: "Order 1234 failed",
  message: "",
  level: "error",
  occurredAt: "2026-10-12T09:00:00.000Z",
  frames: [],
  users: 1,
  count: 1,
};

describe("fingerprint", () => {
  test("same crash site across providers groups together (sentry + posthog)", () => {
    const [a] = normalize(raw("sentry", sentryEvent), "ledgerly");
    const [b] = normalize(raw("posthog", posthog), "ledgerly");
    expect(a && b && fingerprintOf(a)).toBe(b && fingerprintOf(b));
  });

  test("line numbers do not split a group, function names do", () => {
    const frame = { file: "src/a.ts", function: "f", line: 10, inApp: true };
    const a = { ...base, exceptionType: "TypeError", frames: [frame] };
    const moved = { ...a, frames: [{ ...frame, line: 99 }] };
    const other = { ...a, frames: [{ ...frame, function: "g" }] };
    expect(fingerprintOf(a)).toBe(fingerprintOf(moved));
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(other));
  });

  test("library frames are ignored for stack grouping", () => {
    const app = { file: "src/a.ts", function: "f", inApp: true };
    const lib = { file: "node_modules/x/index.js", function: "y", inApp: false };
    const a = { ...base, frames: [lib, app] };
    const b = { ...base, frames: [app] };
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  test("no frames: provider fingerprint, then normalized title", () => {
    expect(fingerprintOf({ ...base, providerFingerprint: "42" })).toMatch(/^pf:/);
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base, title: "Order 99 failed" }));
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, projectId: "q" }));
  });

  test("normalizeTitle masks volatile tokens", () => {
    expect(
      normalizeTitle("User 3fa85f64-5717-4562-b3fc-2c963f66afa6 hit 0xdeadbeef 12 times"),
    ).toBe("user <uuid> hit <hex> <n> times");
  });
});

describe("ingest", () => {
  test("dedupes by signal id and folds counts, users, releases, level", async () => {
    const store = new MemoryIssueStore();
    const s1 = { ...base, release: "1.0", environment: "prod" };
    const s2 = { ...base, id: "x:2", release: "1.1", level: "fatal" as const, count: 3, users: 2 };
    const first = await ingest(store, [s1, s1]);
    expect(first).toHaveLength(1);
    expect(first[0]?.isNew).toBe(true);

    const second = await ingest(store, [s2]);
    const issue = second[0]?.issue;
    expect(second[0]?.isNew).toBe(false);
    expect(issue).toMatchObject({ count: 4, users: 3, level: "fatal", environments: ["prod"] });
    expect(Object.keys(issue?.releases ?? {})).toEqual(["1.0", "1.1"]);
    expect(await store.list()).toHaveLength(1);
  });

  test("a resolved issue that shows up again is marked reopened", async () => {
    const store = new MemoryIssueStore();
    const [r] = await ingest(store, [base]);
    if (!r) throw new Error("no result");
    await store.save({ ...r.issue, status: "resolved" });
    const [again] = await ingest(store, [{ ...base, id: "x:9" }]);
    expect(again?.recurred).toBe(true);
    expect(again?.issue.status).toBe("reopened");
  });
});
