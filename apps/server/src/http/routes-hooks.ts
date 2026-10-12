import { bodyLimit } from "hono/body-limit";
import { HttpError } from "../auth/guard.js";
import type { CorePort, MonitorSignal } from "../core-port.js";
import {
  githubTitle,
  otelTitle,
  posthogTitle,
  sentryTitle,
  verifyGithub,
  verifySentry,
  verifySharedSecret,
  type WebhookSecrets,
} from "../webhooks.js";
import type { App } from "./route.js";

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "invalid_json", "body is not valid JSON");
  }
}

const unauthorized = () =>
  new HttpError(401, "bad_signature", "webhook signature or secret is invalid");

/** Signed inbound webhooks. They don't use API keys: each source proves itself with its own secret. */
export function hookRoutes(app: App, core: CorePort, secrets: WebhookSecrets) {
  app.use("/hooks/*", bodyLimit({ maxSize: 1024 * 1024 }));

  const ingest = async (
    source: MonitorSignal["source"],
    projectId: string | undefined,
    info: { title: string; kind: string; fingerprint?: string },
    payload: unknown,
  ) =>
    core.ingestSignal({
      source,
      kind: info.kind,
      title: info.title,
      payload,
      receivedAt: new Date().toISOString(),
      ...(projectId ? { projectId } : {}),
      ...(info.fingerprint ? { fingerprint: info.fingerprint } : {}),
    });

  app.post("/hooks/sentry", async (c) => {
    const body = await c.req.text();
    if (!verifySentry(secrets.sentry, body, c.req.header("sentry-hook-signature")))
      throw unauthorized();
    const payload = parse(body);
    return c.json(
      await ingest("sentry", c.req.query("project"), sentryTitle(payload), payload),
      202,
    );
  });

  app.post("/hooks/github", async (c) => {
    const body = await c.req.text();
    if (!verifyGithub(secrets.github, body, c.req.header("x-hub-signature-256")))
      throw unauthorized();
    const payload = parse(body);
    const event = c.req.header("x-github-event") ?? "unknown";
    return c.json(
      await ingest("github", c.req.query("project"), githubTitle(event, payload), payload),
      202,
    );
  });

  app.post("/hooks/posthog", async (c) => {
    if (!verifySharedSecret(secrets.posthog, c.req.header("authorization"))) throw unauthorized();
    const payload = parse(await c.req.text());
    return c.json(
      await ingest("posthog", c.req.query("project"), posthogTitle(payload), payload),
      202,
    );
  });

  app.post("/hooks/otel", async (c) => {
    if (!verifySharedSecret(secrets.otel, c.req.header("authorization"))) throw unauthorized();
    const payload = parse(await c.req.text());
    return c.json(await ingest("otel", c.req.query("project"), otelTitle(payload), payload), 202);
  });

  // Orca agent hooks report worktree/agent status so runs started in Orca stay in sync.
  app.post("/hooks/orca", async (c) => {
    if (!verifySharedSecret(secrets.orca, c.req.header("authorization"))) throw unauthorized();
    const payload = parse(await c.req.text()) as Record<string, unknown>;
    const worktree = typeof payload.worktree === "string" ? payload.worktree : undefined;
    const agent = typeof payload.agent === "string" ? payload.agent : undefined;
    const status = typeof payload.status === "string" ? payload.status : undefined;
    if (!worktree || !agent || !status) {
      throw new HttpError(400, "invalid_request", "worktree, agent and status are required");
    }
    await core.recordOrcaStatus({
      worktree,
      agent,
      status,
      receivedAt: new Date().toISOString(),
      ...(typeof payload.runId === "string" ? { runId: payload.runId } : {}),
      ...(typeof payload.message === "string" ? { message: payload.message.slice(0, 2000) } : {}),
    });
    return c.json({ ok: true }, 202);
  });
}
