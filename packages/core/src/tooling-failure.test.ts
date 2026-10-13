import { expect, test } from "vitest";
import { FactoryToolingError } from "./handlers.js";
import { advance, initialState } from "./machine.js";
import { createHarness, testProject } from "./testing/index.js";

test("factory/tooling checks failure blocks without incrementing attempts or implement loops", async () => {
  const harness = createHarness({ project: { maxAttempts: 5, maxLoops: 5 } });
  harness.deps.architecture = async () => {
    throw new FactoryToolingError("host-derived graph is stale; repair factory regeneration", [
      {
        kind: "adr-check",
        ok: false,
        summary: "graph stale",
        data: { stale: [".matrix/graph/code.json"] },
      },
    ]);
  };
  try {
    await harness.setup();
    const ticket = harness.tickets.add("explicit fake-runtime tooling fixture");
    for (let index = 0; index < 3; index++) {
      await harness.reconciler.tick();
      await harness.reconciler.idle();
    }
    const workflow = await harness.store.getWorkflow(harness.project.id, ticket.id);
    expect(workflow).toMatchObject({ phase: "checks", status: "blocked", loops: 0, attempt: 0 });
    expect(workflow?.lastError).toContain("factory/tooling error at checks");
    const runs = await harness.store.listRuns({ ticketId: ticket.id });
    expect(runs.map((run) => run.phase)).toEqual(["spike", "implement", "checks"]);
    const receipts = await harness.store.listReceipts(runs[2]!.id);
    expect(receipts.some((receipt) => receipt.kind === "test" && receipt.ok)).toBe(true);
    expect(receipts.some((receipt) => receipt.kind === "adr-check" && !receipt.ok)).toBe(true);
    await harness.reconciler.tick();
    expect(await harness.store.listRuns({ ticketId: ticket.id })).toHaveLength(3);
  } finally {
    harness.reconciler.stop();
    await harness.reconciler.idle();
  }
});

test("ordinary failed checks still retain the implement loop and staleness gate", () => {
  const state = {
    ...initialState("fixture", "ticket"),
    phase: "checks" as const,
    status: "running" as const,
  };
  const transition = advance(
    state,
    {
      ok: false,
      summary: "normal source failure",
      runStatus: "ok",
      receipts: [{ kind: "adr-check", ok: false, summary: "code graph is stale" }],
    },
    testProject(),
    { baseMs: 1, maxMs: 1 },
    new Date(),
  );
  expect(transition.state).toMatchObject({ phase: "implement", status: "pending", loops: 1 });
});
test("factory tooling failures take priority over design restart without consuming loops", () => {
  const transition = advance(
    { ...initialState("fixture", "ticket"), phase: "qa", status: "running" },
    {
      ok: false,
      summary: "host tooling unavailable",
      receipts: [],
      failureClass: "factory-tooling",
      restartDesign: true,
    },
    testProject({ agents: { designFirst: true } }),
    { baseMs: 1, maxMs: 1 },
    new Date(),
  );
  expect(transition.state).toMatchObject({ phase: "qa", status: "blocked", loops: 0, attempt: 0 });
});
