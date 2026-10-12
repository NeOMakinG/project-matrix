import { describe, expect, test } from "vitest";
import { createServer } from "./http/app.js";
import { MemoryCore } from "./memory-core.js";
import { AGENT, SECRETS, setup } from "./test-helpers.js";

describe("dashboard endpoints (round 2)", () => {
  test("integrations report configured webhooks without exposing secrets", async () => {
    const ctx = await setup();
    const response = await ctx.call(ctx.key(["read"]), "GET", "/v1/integrations");
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    const rows = JSON.parse(text) as { name: string; status: { label: string } }[];
    expect(rows.find((r) => r.name === "Sentry")?.status.label).toBe("connected");

    const bare = createServer({ core: new MemoryCore() });
    const token = bare.keys.create({
      name: "r",
      scope: { projects: "*", actions: ["read"] },
    }).token;
    const bareRows = (await (
      await bare.app.request("/v1/integrations", { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { name: string; status: { label: string } }[];
    expect(bareRows.find((r) => r.name === "Sentry")?.status.label).toBe("not configured");
  });

  test("init progress walks the question packs; unknown or invalid answers are rejected", async () => {
    const ctx = await setup();
    const session = await ctx.json<{ id: string }>(
      await ctx.call(ctx.admin, "POST", `/v1/projects/${ctx.project.id}/init`),
    );
    const progress = await ctx.json<{
      packs: { id: string; state: string }[];
      question: { id: string; pack: string; options: { recommended: boolean }[] } | null;
      configPreview: string;
    }>(await ctx.call(ctx.admin, "GET", `/v1/init/${session.id}/progress`));
    expect(progress.packs[0]).toMatchObject({ id: "business", state: "active" });
    expect(progress.question?.pack).toBe("business");
    expect(progress.configPreview).toContain("defineConfig");

    const answer = (answers: Record<string, unknown>) =>
      ctx.call(ctx.admin, "POST", `/v1/init/${session.id}/answers`, { answers });
    expect((await answer({ "not-a-question": "x" })).status).toBe(400);
    expect((await answer({ [progress.question?.id ?? ""]: { nested: "object" } })).status).toBe(
      400,
    );
  });

  test("checks endpoint returns the latest matrix check result, scoped to the project", async () => {
    const ctx = await setup();
    ctx.core.checks.set(ctx.project.id, {
      ref: "main@abc123",
      violations: [
        {
          level: "error",
          adr: "0007",
          location: "src/a.ts:3",
          message: "money as float",
          note: "",
        },
      ],
    });
    const ok = await ctx.json<{ ref: string; violations: unknown[] }>(
      await ctx.call(ctx.key(["read"]), "GET", `/v1/projects/${ctx.project.id}/checks`),
    );
    expect(ok).toMatchObject({ ref: "main@abc123" });
    expect(ok.violations).toHaveLength(1);
    expect(
      (await ctx.call(ctx.key(["read"]), "GET", `/v1/projects/${ctx.other.id}/checks`)).status,
    ).toBe(403);
  });

  test("settings writes use ETag / If-Match and return 412 on a stale ETag", async () => {
    const ctx = await setup();
    const first = await ctx.call(ctx.admin, "GET", "/v1/settings");
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    const patch = (ifMatch: string, body: unknown) =>
      ctx.server.app.request("/v1/settings", {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${ctx.admin}`,
          "content-type": "application/json",
          "if-match": ifMatch,
        },
        body: JSON.stringify(body),
      });
    const saved = await patch(etag, { runners: { implement: "claude-code" } });
    expect(saved.status).toBe(200);
    const next = saved.headers.get("etag");
    expect(next).not.toBe(etag);
    expect((await patch(etag, { runners: { implement: "codex" } })).status).toBe(412);
    expect((await patch(next ?? "", { runners: { implement: "codex" } })).status).toBe(200);
  });

  test("runs carry title, PR URL and their latest approval state", async () => {
    const ctx = await setup();
    const ticket = await ctx.core.createTicket(ctx.project.id, {
      title: "Stripe checkout",
      body: "",
    });
    const run = await ctx.core.startRun(
      { projectId: ctx.project.id, ticketId: ticket.id, phase: "qa" },
      AGENT,
    );
    ctx.core.runs.set(run.id, { ...run, prUrl: "https://github.com/acme/app/pull/58" });
    ctx.core.setHead(run.id, "abc1234def");
    const reader = ctx.key(["read"]);
    const before = await ctx.json<{ title: string; approval: { state: string } }>(
      await ctx.call(reader, "GET", `/v1/runs/${run.id}`),
    );
    expect(before).toMatchObject({ title: "Stripe checkout", approval: { state: "none" } });

    const approval = ctx.core.requestApproval(run.id, "merge");
    const listed = await ctx.json<
      { prUrl: string; approval: { state: string; approvalId: string } }[]
    >(await ctx.call(reader, "GET", `/v1/runs?projectId=${ctx.project.id}`));
    expect(listed[0]).toMatchObject({
      prUrl: "https://github.com/acme/app/pull/58",
      approval: { state: "pending", approvalId: approval.id },
    });
  });
});

describe("SSE resume", () => {
  test("events carry ids and a reconnect with Last-Event-ID replays what was missed", async () => {
    const ctx = await setup();
    const ticket = await ctx.core.createTicket(ctx.project.id, { title: "t", body: "" });
    const run = await ctx.core.startRun(
      { projectId: ctx.project.id, ticketId: ticket.id, phase: "qa" },
      AGENT,
    );
    const token = ctx.key(["read"]);
    const decoder = new TextDecoder();

    const first = await ctx.call(token, "GET", `/v1/runs/${run.id}/events`);
    const reader = first.body?.getReader();
    await reader?.read(); // ready
    for (const n of [1, 2, 3]) {
      ctx.core.emit({
        runId: run.id,
        at: new Date().toISOString(),
        kind: "log",
        message: `line ${n}`,
      });
    }
    let seen = "";
    while (!seen.includes("line 1")) seen += decoder.decode((await reader?.read())?.value);
    await reader?.cancel();
    expect(seen).toMatch(/^id: 1$/m);

    const resumed = await ctx.server.app.request(`/v1/runs/${run.id}/events`, {
      headers: { authorization: `Bearer ${token}`, "last-event-id": "1" },
    });
    const again = resumed.body?.getReader();
    let text = "";
    while (!text.includes("line 3")) text += decoder.decode((await again?.read())?.value);
    await again?.cancel();
    expect(text).toContain('"resumed":true');
    expect(text).not.toContain("line 1");
    expect(text).toMatch(/^id: 2$/m);
    expect(text).toMatch(/^id: 3$/m);
  });
});
