import { describe, expect, test } from "vitest";
import { AGENT, setup } from "./test-helpers.js";

const SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const OTHER_SHA = "ffffffffffffffffffffffffffffffffffffffff";

type Ctx = Awaited<ReturnType<typeof setup>>;

async function readyRun(ctx: Ctx, receiptsOk = true) {
  const ticket = await ctx.core.createTicket(ctx.project.id, { title: "t", body: "" });
  const run = await ctx.core.startRun(
    { projectId: ctx.project.id, ticketId: ticket.id, phase: "qa" },
    AGENT,
  );
  ctx.core.setHead(run.id, SHA);
  ctx.core.receipts.set(run.id, [{ kind: "test", ok: receiptsOk, summary: "vitest" }]);
  return run.id;
}

const human = (ctx: Ctx, actions: Parameters<Ctx["key"]>[0]) =>
  ctx.server.keys.create({
    name: "human",
    kind: "human",
    scope: { projects: [ctx.project.id], actions },
  }).token;

describe("P1: key minting can't escalate", () => {
  test("a project-scoped admin can't mint a global key or reach factory-wide operations", async () => {
    const ctx = await setup();
    const projectAdmin = ctx.key(["admin"]);
    const mint = (scope: unknown, extra: object = {}) =>
      ctx.call(projectAdmin, "POST", "/v1/keys", { name: "x", scope, ...extra });

    expect((await mint({ projects: "*", actions: ["admin"] })).status).toBe(403);
    expect((await mint({ projects: [ctx.other.id], actions: ["read"] })).status).toBe(403);
    expect((await mint({ projects: [ctx.project.id], actions: ["read"] })).status).toBe(200);

    for (const [method, path] of [
      ["GET", "/v1/keys"],
      ["GET", "/v1/audit"],
      ["GET", "/v1/settings"],
      ["PATCH", "/v1/settings"],
      ["POST", "/v1/projects"],
    ] as const) {
      const body = method === "GET" ? undefined : method === "PATCH" ? {} : { name: "p" };
      expect((await ctx.call(projectAdmin, method, path, body)).status, path).toBe(403);
    }
  });

  test("minted keys can't exceed the creator's actions, budget or rate limit", async () => {
    const ctx = await setup();
    const limited = ctx.server.keys.create({
      name: "limited-admin",
      scope: { projects: "*", actions: ["admin"] },
      budget: { runsPerDay: 5 },
      ratePerMinute: 30,
    }).token;
    const mint = (extra: object) =>
      ctx.call(limited, "POST", "/v1/keys", {
        name: "x",
        scope: { projects: [ctx.project.id], actions: ["read"] },
        ...extra,
      });
    expect((await mint({})).status).toBe(403); // no runsPerDay → unbounded, wider than creator
    expect((await mint({ budget: { runsPerDay: 10 } })).status).toBe(403);
    expect((await mint({ budget: { runsPerDay: 5 }, ratePerMinute: 60 })).status).toBe(403);
    expect((await mint({ budget: { runsPerDay: 5 }, ratePerMinute: 30 })).status).toBe(200);

    const reader = ctx.key(["admin"], [ctx.project.id]);
    const downgraded = await ctx.call(reader, "POST", "/v1/keys", {
      name: "y",
      kind: "human",
      scope: { projects: [ctx.project.id], actions: ["read"] },
    });
    expect(downgraded.status).toBe(403); // agent keys can't mint human keys
  });
});

describe("P2: approval, merge and deploy gates", () => {
  test("an approval is bound to the head commit it was requested for", async () => {
    const ctx = await setup();
    const runId = await readyRun(ctx);
    const reviewer = human(ctx, ["runs:approve", "merge"]);
    const decide = (id: string, decision: "approved" | "rejected") =>
      ctx.call(reviewer, "POST", `/v1/approvals/${id}/decision`, { decision });

    const stale = ctx.core.requestApproval(runId);
    ctx.core.setHead(runId, OTHER_SHA); // a new commit lands after the request
    expect((await decide(stale.id, "approved")).status).toBe(409);
    expect((await ctx.call(reviewer, "POST", `/v1/runs/${runId}/merge`)).status).toBe(409);

    const fresh = ctx.core.requestApproval(runId);
    expect((await decide(fresh.id, "approved")).status).toBe(200);
    expect((await decide(fresh.id, "rejected")).status).toBe(409); // already decided
    expect((await ctx.call(reviewer, "POST", `/v1/runs/${runId}/merge`)).status).toBe(200);
    expect((await ctx.call(reviewer, "POST", `/v1/runs/${runId}/merge`)).status).toBe(409);
  });

  test("requester, reconcilers and the run owner can't decide; human phases need a human key", async () => {
    const ctx = await setup();
    const owner = ctx.key(["runs:start", "runs:approve"]);
    const ticket = await ctx.core.createTicket(ctx.project.id, { title: "t", body: "" });
    const started = await ctx.json<{ id: string; ownerId: string }>(
      await ctx.call(owner, "POST", "/v1/runs", {
        projectId: ctx.project.id,
        ticketId: ticket.id,
        phase: "qa",
      }),
    );
    expect(started.ownerId).toMatch(/^key:/);
    ctx.core.setHead(started.id, SHA);
    await ctx.core.setAutonomy(ctx.project.id, "merge", "gated");
    const approval = ctx.core.requestApproval(started.id);
    const decide = (token: string) =>
      ctx.call(token, "POST", `/v1/approvals/${approval.id}/decision`, { decision: "approved" });

    expect((await decide(owner)).status).toBe(403); // run owner

    const requested = ctx.core.requestApproval(
      started.id,
      "merge",
      `key:${ctx.key(["read"]).split("_")[1]}`,
    );
    await expect(
      ctx.core.decideApproval(requested.id, "approved", requested.requestedBy),
    ).rejects.toThrow(/requested/);
    await expect(
      ctx.core.decideApproval(approval.id, "approved", "reconciler:other"),
    ).rejects.toThrow(/requested/);

    await ctx.core.setAutonomy(ctx.project.id, "merge", "human");
    expect((await decide(ctx.key(["runs:approve"]))).status).toBe(403); // agent key, human phase
    expect((await decide(human(ctx, ["runs:approve"]))).status).toBe(200);
  });

  test("gated merge needs passing receipts; failed and cancelled runs are never mergeable", async () => {
    const ctx = await setup();
    await ctx.core.setAutonomy(ctx.project.id, "merge", "gated");
    const merger = ctx.key(["merge"]);
    const failing = await readyRun(ctx, false);
    expect((await ctx.call(merger, "POST", `/v1/runs/${failing}/merge`)).status).toBe(409);

    for (const state of ["failed", "cancelled", "timeout"] as const) {
      const runId = await readyRun(ctx);
      const run = ctx.core.runs.get(runId);
      if (run) ctx.core.runs.set(runId, { ...run, state });
      expect((await ctx.call(merger, "POST", `/v1/runs/${runId}/merge`)).status, state).toBe(409);
    }
    const passing = await readyRun(ctx);
    expect((await ctx.call(merger, "POST", `/v1/runs/${passing}/merge`)).status).toBe(200);
  });

  test("deploy honours deploy autonomy", async () => {
    const ctx = await setup();
    const agent = ctx.key(["deploy", "merge"]);
    const person = human(ctx, ["deploy"]);
    const deploy = (token: string) =>
      ctx.call(token, "POST", `/v1/projects/${ctx.project.id}/deploy`);

    expect((await deploy(agent)).status).toBe(403); // human mode (default)
    expect((await deploy(person)).status).toBe(200);

    await ctx.core.setAutonomy(ctx.project.id, "deploy", "gated");
    expect((await deploy(agent)).status).toBe(409); // nothing merged yet
    await ctx.core.setAutonomy(ctx.project.id, "merge", "gated");
    const runId = await readyRun(ctx);
    expect((await ctx.call(agent, "POST", `/v1/runs/${runId}/merge`)).status).toBe(200);
    expect((await deploy(agent)).status).toBe(200);
  });

  test("starting a run on another project's ticket is refused", async () => {
    const ctx = await setup();
    const foreign = await ctx.core.createTicket(ctx.other.id, { title: "foreign", body: "" });
    const response = await ctx.call(ctx.key(["runs:start"]), "POST", "/v1/runs", {
      projectId: ctx.project.id,
      ticketId: foreign.id, // exists, but in the other project
      phase: "spike",
    });
    expect(response.status).toBe(404);
  });
});
