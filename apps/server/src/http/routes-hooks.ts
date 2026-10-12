import { createHash } from "node:crypto";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HttpError } from "../auth/guard.js";
import type { Clock } from "../auth/limits.js";
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
import type { App, AppEnv } from "./route.js";

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "invalid_json", "body is not valid JSON");
  }
}

const unauthorized = () =>
  new HttpError(401, "bad_signature", "webhook signature or secret is invalid");

/** Remembers accepted deliveries for 7 days so a captured, validly signed request can't be replayed. */
export class DeliveryLog {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly clock: Clock = Date.now,
    private readonly ttlMs = 7 * 24 * 60 * 60 * 1000,
    private readonly max = 50_000,
  ) {}

  /** Returns false when this delivery was already accepted. */
  accept(id: string): boolean {
    const now = this.clock();
    for (const [key, at] of this.seen) {
      if (at > now - this.ttlMs && this.seen.size <= this.max) break;
      this.seen.delete(key);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    return true;
  }
}

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
export function hookRoutes(app: App, core: CorePort, secrets: WebhookSecrets, clock?: Clock) {
  const deliveries = new DeliveryLog(clock);
  app.use("/hooks/*", bodyLimit({ maxSize: 1024 * 1024 }));

  /**
   * Replay key = what the sender actually authenticated: the body plus its signature header (empty for
   * shared-secret sources). Delivery-id headers aren't signed, so they're never trusted for dedupe.
   */
  const replayKey = (source: Source, signatureHeader: string | undefined, body: string) =>
    `${source}:${createHash("sha256")
      .update(`${signatureHeader ?? ""}\n${body}`)
      .digest("hex")}`;

  /** Sentry sends `sentry-hook-timestamp`; reject deliveries outside a ±5 minute window when present. */
  const freshEnough = (timestamp: string | undefined) => {
    if (timestamp === undefined) return true;
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
      throw new HttpError(401, "stale", "webhook timestamp outside the accepted window");
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

  // Orca agent hooks report worktree/agent status so runs started in Orca stay in sync.
  app.post("/hooks/orca", async (c) => {
    if (!verifySharedSecret(secrets.orca, c.req.header("authorization"))) throw unauthorized();
    const payload = parse(await c.req.text()) as Record<string, unknown>;
    const field = (name: string, max: number) =>
      typeof payload[name] === "string" ? (payload[name] as string).slice(0, max) : undefined;
    const worktree = field("worktree", 300);
    const agent = field("agent", 100);
    const status = field("status", 100);
    if (!worktree || !agent || !status) {
      throw new HttpError(400, "invalid_request", "worktree, agent and status are required");
    }
    const runId = field("runId", 200);
    const message = field("message", 2000);
    await core.recordOrcaStatus({
      worktree,
      agent,
      status,
      receivedAt: new Date().toISOString(),
      ...(runId ? { runId } : {}),
      ...(message ? { message } : {}),
    });
    return c.json({ ok: true }, 202);
  });
}
