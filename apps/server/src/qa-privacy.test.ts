import { expect, test } from "vitest";
import { AGENT, setup } from "./test-helpers.js";

test("authenticated receipts API hides private QA evidence and judge reasons", async () => {
  const ctx = await setup();
  const ticket = await ctx.core.createTicket(ctx.project.id, { title: "addition", body: "" });
  const run = await ctx.core.startRun(
    { projectId: ctx.project.id, ticketId: ticket.id, phase: "qa" },
    AGENT,
  );
  ctx.core.receipts.set(run.id, [
    {
      kind: "holdout",
      ok: true,
      summary: "PRIVATE",
      data: {
        provenance: "core-judge",
        satisfied: 4,
        total: 4,
        satisfaction: 1,
        verdicts: [{ id: "PRIVATE", reason: "PRIVATE" }],
      },
    },
    {
      kind: "test",
      ok: true,
      summary: "PRIVATE",
      data: {
        provenance: "host-probe",
        headSha: "a".repeat(40),
        id: "PRIVATE",
        command: ["bun", "PRIVATE"],
        exitCode: 0,
        output: "PRIVATE",
        probe: "PRIVATE",
      },
    },
  ]);
  const response = await ctx.call(ctx.key(["read"]), "GET", `/v1/runs/${run.id}/receipts`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain("PRIVATE");
  expect(body).toContain('"satisfied":4');
  const denied = await ctx.call(
    ctx.key(["read"], [ctx.other.id]),
    "GET",
    `/v1/runs/${run.id}/receipts`,
  );
  expect(denied.status).toBe(403);
});
