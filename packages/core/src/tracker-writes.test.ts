import { expect, test } from "vitest";
import type { TrackerFailedEvent } from "./bus.js";
import { createHarness } from "./testing/harness.js";

test("a down tracker never fails the workflow and every failed write is published", async () => {
  const h = createHarness();
  await h.setup();
  const t = h.tickets.add("Tracker outage");
  // Reads keep working (pickup), every write fails like a Linear outage.
  h.tickets.update = async () => {
    throw new Error("Linear request failed: 503");
  };
  h.tickets.comment = async () => {
    throw new Error("Linear request failed: 503");
  };
  await h.drain();
  expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("done");
  const failed = h.events.filter((e): e is TrackerFailedEvent => e.type === "tracker.failed");
  const ops = new Set(failed.map((e) => e.operation));
  expect(ops).toEqual(new Set(["update", "comment"]));
  for (const event of failed) {
    expect(event).toMatchObject({ projectId: "pilot", ticketId: t.id });
    expect(event.message).toContain("503");
    expect(Number.isNaN(Date.parse(event.at))).toBe(false);
  }
});
