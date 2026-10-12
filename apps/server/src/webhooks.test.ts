import { describe, expect, test } from "vitest";
import { createServer } from "./http/app.js";
import { MemoryCore } from "./memory-core.js";
import { SECRETS, setup } from "./test-helpers.js";
import { hmacHex } from "./webhooks.js";

const post = async (
  ctx: Awaited<ReturnType<typeof setup>>,
  path: string,
  body: string,
  headers: Record<string, string>,
) =>
  ctx.server.app.request(path, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });

describe("webhooks", () => {
  test("Sentry: valid HMAC is ingested, tampered body is rejected", async () => {
    const ctx = await setup();
    const body = JSON.stringify({
      action: "created",
      data: { issue: { id: "42", title: "TypeError in checkout" } },
    });
    const signature = hmacHex(SECRETS.sentry ?? "", body);
    const ok = await post(ctx, `/hooks/sentry?project=${ctx.project.id}`, body, {
      "sentry-hook-signature": signature,
    });
    expect(ok.status).toBe(202);
    expect(ctx.core.signals[0]).toMatchObject({
      source: "sentry",
      title: "TypeError in checkout",
      fingerprint: "42",
      projectId: ctx.project.id,
    });
    const tampered = await post(ctx, "/hooks/sentry", body.replace("checkout", "login"), {
      "sentry-hook-signature": signature,
    });
    expect(tampered.status).toBe(401);
    expect(ctx.core.signals).toHaveLength(1);
  });

  test("GitHub: sha256= signature required", async () => {
    const ctx = await setup();
    const body = JSON.stringify({
      action: "completed",
      workflow_run: { name: "CI", conclusion: "failure" },
    });
    const good = `sha256=${hmacHex(SECRETS.github ?? "", body)}`;
    expect(
      (
        await post(ctx, "/hooks/github", body, {
          "x-github-event": "workflow_run",
          "x-hub-signature-256": good,
        })
      ).status,
    ).toBe(202);
    expect(ctx.core.signals[0]).toMatchObject({
      kind: "workflow_run.completed",
      title: "CI: failure",
    });
    expect(
      (await post(ctx, "/hooks/github", body, { "x-hub-signature-256": "sha256=00" })).status,
    ).toBe(401);
    expect((await post(ctx, "/hooks/github", body, {})).status).toBe(401);
  });

  test("PostHog and OpenTelemetry use a shared bearer secret", async () => {
    const ctx = await setup();
    const ph = JSON.stringify({
      event: { event: "$exception", properties: { $exception_message: "boom" } },
    });
    expect(
      (await post(ctx, "/hooks/posthog", ph, { authorization: `Bearer ${SECRETS.posthog}` }))
        .status,
    ).toBe(202);
    expect((await post(ctx, "/hooks/posthog", ph, { authorization: "Bearer wrong" })).status).toBe(
      401,
    );
    const alert = JSON.stringify({
      status: "firing",
      alerts: [{ labels: { alertname: "HighErrorRate" }, fingerprint: "f1" }],
    });
    expect(
      (await post(ctx, "/hooks/otel", alert, { authorization: `Bearer ${SECRETS.otel}` })).status,
    ).toBe(202);
    expect(ctx.core.signals.map((s) => s.title)).toEqual(["boom", "HighErrorRate"]);
  });

  test("API keys are not accepted as webhook secrets", async () => {
    const ctx = await setup();
    const body = JSON.stringify({ event: {} });
    expect(
      (await post(ctx, "/hooks/posthog", body, { authorization: `Bearer ${ctx.admin}` })).status,
    ).toBe(401);
  });

  test("Orca hook records agent status and validates fields", async () => {
    const ctx = await setup();
    const auth = { authorization: `Bearer ${SECRETS.orca}` };
    const body = JSON.stringify({
      worktree: "wt/pilot-142",
      agent: "claude-code",
      status: "working",
      runId: "r1",
    });
    expect((await post(ctx, "/hooks/orca", body, auth)).status).toBe(202);
    expect(ctx.core.orca[0]).toMatchObject({
      worktree: "wt/pilot-142",
      status: "working",
      runId: "r1",
    });
    expect((await post(ctx, "/hooks/orca", JSON.stringify({ agent: "x" }), auth)).status).toBe(400);
    expect((await post(ctx, "/hooks/orca", "{not json", auth)).status).toBe(400);
  });

  test("unconfigured secrets reject everything, even an empty signature", async () => {
    const { app } = createServer({ core: new MemoryCore() });
    const body = JSON.stringify({});
    for (const path of [
      "/hooks/sentry",
      "/hooks/github",
      "/hooks/posthog",
      "/hooks/otel",
      "/hooks/orca",
    ]) {
      const response = await app.request(path, {
        method: "POST",
        body,
        headers: { "sentry-hook-signature": hmacHex("", body), authorization: "Bearer " },
      });
      expect(response.status, path).toBe(401);
    }
  });
});
