import { expect, test } from "vitest";
import { FactoryToolingError } from "./handlers.js";
import { publicQaReceipt } from "./qa-evidence.js";
import { createHarness } from "./testing/harness.js";

test("public holdout receipts expose numeric counts only, never reasons or ids", () => {
  const receipt = publicQaReceipt({
    kind: "holdout",
    ok: true,
    summary: "PRIVATE scenario",
    data: {
      provenance: "core-judge",
      satisfied: 4,
      total: 4,
      satisfaction: 1,
      verdicts: [{ id: "PRIVATE", reason: "PRIVATE", satisfied: true }],
    },
  });
  expect(receipt.data).toEqual({ satisfied: 4, total: 4, satisfaction: 1 });
  expect(JSON.stringify(receipt)).not.toContain("PRIVATE");
});

test("QA bus payload hides scenario probes and judge rationale but private Store retains evidence", async () => {
  const privateText = "PRIVATE holdout scenario";
  const harness = createHarness({
    qaReceipts: () => [
      {
        kind: "test",
        ok: true,
        summary: privateText,
        data: {
          provenance: "host-probe",
          headSha: "a".repeat(40),
          id: "s1",
          command: ["bun", "probe.ts"],
          exitCode: 0,
          output: privateText,
          probe: privateText,
        },
      },
    ],
    verdicts: () =>
      JSON.stringify({
        verdicts: ["s1", "s2"].map((id) => ({ id, satisfied: true, reason: privateText })),
      }),
  });
  await harness.setup();
  const ticket = harness.tickets.add("addition");
  await harness.drain();
  expect(JSON.stringify(harness.events)).not.toContain(privateText);
  expect(JSON.stringify(harness.tickets.comments)).not.toContain(privateText);
  const run = (await harness.store.listRuns({ ticketId: ticket.id })).find(
    (item) => item.phase === "qa",
  )!;
  expect(JSON.stringify(await harness.store.listReceipts(run.id))).toContain(privateText);
});

test("planner failure blocks with generic ticket feedback, never model text", async () => {
  const privateText = "PRIVATE add(2,3) scenario";
  const harness = createHarness();
  harness.deps.qa = {
    run: async () => {
      throw new FactoryToolingError(privateText);
    },
  };
  await harness.setup();
  const ticket = harness.tickets.add("addition");
  await harness.drain();
  expect((await harness.store.getWorkflow(harness.project.id, ticket.id))?.status).toBe("blocked");
  expect(harness.tickets.comments.length).toBeGreaterThan(0);
  expect(JSON.stringify(harness.tickets.comments)).not.toContain(privateText);
  expect(JSON.stringify(harness.events)).not.toContain(privateText);
  expect(JSON.stringify(await harness.store.listRuns({ ticketId: ticket.id }))).not.toContain(
    privateText,
  );
});
