import { createHash } from "node:crypto";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HttpError } from "../auth/guard.js";
import type { Clock } from "../auth/limits.js";
import type { ReplayLog } from "../auth/replay-log.js";
import type { CorePort, MonitorSignal } from "../core-port.js";
import {
  githubTitle,
  hmacHex,
  otelTitle,
  posthogTitle,
  safeEqual,
  sentryTitle,
  verifyGithub,
  verifySentry,
  verifySharedSecret,
  type WebhookSecrets,
} from "../webhooks.js";
import type { App, AppEnv } from "./route.js";

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "invalid_json", "body is not valid JSON");
  }
}

const TERMINAL_ORCA_STATUSES = new Set(["done", "failed", "cancelled", "error", "exited"]);

const unauthorized = () =>
  new HttpError(401, "bad_signature", "webhook signature or secret is invalid");

type Source = MonitorSignal["source"] | "orca";

/**
 * Picks the secret for a request. A `?project=` attribution is only trusted when the request is
 * verified with that project's own secret; with the global secret the signal stays unattributed,
 * so a payload signed for one project can't be replayed into another.
 */
function secretFor(
  secrets: WebhookSecrets,
  source: Source,
  projectId: string | undefined,
): { secret: string | undefined; projectId?: string } {
  if (projectId) return { secret: secrets.projects?.[projectId]?.[source], projectId };
  return { secret: secrets[source] };
}

/** Signed inbound webhooks. They don't use API keys: each source proves itself with its own secret. */
export function hookRoutes(
  app: App,
  core: CorePort,
  secrets: WebhookSecrets,
  deliveries: ReplayLog,
  clock?: Clock,
) {
  const orcaState = new Map<string, { at: number; status: string }>();
  app.use("/hooks/*", bodyLimit({ maxSize: 1024 * 1024 }));

  /**
   * Replay key = what the sender actually authenticated: the body plus its signature header (empty for
   * shared-secret sources). Delivery-id headers aren't signed, so they're never trusted for dedupe.
   */
  const replayKey = (source: Source, signatureHeader: string | undefined, body: string) =>
    `${source}:${createHash("sha256")
      .update(`${signatureHeader ?? ""}\n${body}`)
      .digest("hex")}`;

  /** Timestamps (unix seconds) must be present and within ±5 minutes. */
  const freshEnough = (timestamp: string | undefined) => {
    if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp)) return false;
    const sentAt = Number(timestamp) * 1000;
    const now = clock ? clock() : Date.now();
    return Number.isFinite(sentAt) && Math.abs(now - sentAt) <= 5 * 60 * 1000;
  };

  const handle = async (
    c: Context<AppEnv>,
    source: MonitorSignal["source"],
    verify: (secret: string | undefined, body: string) => boolean,
    signatureHeader: string | undefined,
    describe: (payload: unknown) => { title: string; kind: string; fingerprint?: string },
  ) => {
    const body = await c.req.text();
    const target = secretFor(secrets, source, c.req.query("project"));
    if (!verify(target.secret, body)) throw unauthorized();
    if (source === "sentry" && !freshEnough(c.req.header("sentry-hook-timestamp"))) {
      throw new HttpError(401, "stale", "missing webhook timestamp or outside the accepted window");
    }
    if (
      !deliveries.accept(
        replayKey(source, signatureHeader ? c.req.header(signatureHeader) : undefined, body),
      )
    ) {
      return c.json({ duplicate: true }, 200);
    }
    const payload = parse(body);
    const info = describe(payload);
    const signal = await core.ingestSignal({
      source,
      kind: info.kind,
      title: info.title,
      payload,
      receivedAt: new Date().toISOString(),
      ...(target.projectId ? { projectId: target.projectId } : {}),
      ...(info.fingerprint ? { fingerprint: info.fingerprint } : {}),
    });
    return c.json(signal, 202);
  };

  app.post("/hooks/sentry", (c) =>
    handle(
      c,
      "sentry",
      (secret, body) => verifySentry(secret, body, c.req.header("sentry-hook-signature")),
      "sentry-hook-signature",
      sentryTitle,
    ),
  );

  app.post("/hooks/github", (c) =>
    handle(
      c,
      "github",
      (secret, body) => verifyGithub(secret, body, c.req.header("x-hub-signature-256")),
      "x-hub-signature-256",
      (payload) => githubTitle(c.req.header("x-github-event") ?? "unknown", payload),
    ),
  );

  app.post("/hooks/posthog", (c) =>
    handle(
      c,
      "posthog",
      (secret) => verifySharedSecret(secret, c.req.header("authorization")),
      undefined,
      posthogTitle,
    ),
  );

  app.post("/hooks/otel", (c) =>
    handle(
      c,
      "otel",
      (secret) => verifySharedSecret(secret, c.req.header("authorization")),
      undefined,
      otelTitle,
    ),
  );

  /**
   * Orca agent hooks. Signed: `x-orca-signature: sha256=HMAC(secret, "<timestamp>.<nonce>.<body>")`
   * with `x-orca-timestamp` (unix seconds, ±5 min) and a single-use `x-orca-nonce`. Status updates are
   * applied in timestamp order per worktree; older or replayed ones are ignored, and a worktree that
   * reached a terminal status doesn't move again.
   */
  app.post("/hooks/orca", async (c) => {
    const body = await c.req.text();
    const timestamp = c.req.header("x-orca-timestamp");
    const nonce = c.req.header("x-orca-nonce");
    const signature = c.req.header("x-orca-signature");
    if (!secrets.orca || !timestamp || !nonce || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
      throw unauthorized();
    }
    const expected = `sha256=${hmacHex(secrets.orca, `${timestamp}.${nonce}.${body}`)}`;
    if (!signature || !safeEqual(expected, signature)) throw unauthorized();
    if (!freshEnough(timestamp)) {
      throw new HttpError(401, "stale", "missing timestamp or outside the accepted window");
    }
    if (!deliveries.accept(`orca-nonce:${nonce}`)) return c.json({ duplicate: true }, 200);

    const payload = parse(body) as Record<string, unknown>;
    const field = (name: string, max: number) =>
      typeof payload[name] === "string" ? (payload[name] as string).slice(0, max) : undefined;
    const worktree = field("worktree", 300);
    const agent = field("agent", 100);
    const status = field("status", 100);
    if (!worktree || !agent || !status) {
      throw new HttpError(400, "invalid_request", "worktree, agent and status are required");
    }
    const at = Number(timestamp) * 1000;
    const previous = orcaState.get(worktree);
    if (previous && at <= previous.at) return c.json({ ignored: "out_of_order" }, 200);
    if (previous && TERMINAL_ORCA_STATUSES.has(previous.status) && status !== previous.status) {
      return c.json({ ignored: "terminal" }, 200);
    }
    orcaState.set(worktree, { at, status });
    const runId = field("runId", 200);
    const message = field("message", 2000);
    await core.recordOrcaStatus({
      worktree,
      agent,
      status,
      receivedAt: new Date(at).toISOString(),
      ...(runId ? { runId } : {}),
      ...(message ? { message } : {}),
    });
    return c.json({ ok: true }, 202);
  });
}
