import { createHmac, timingSafeEqual } from "node:crypto";

export interface SourceSecrets {
  sentry?: string;
  github?: string;
  posthog?: string;
  otel?: string;
  orca?: string;
}

/** Global secrets (unattributed signals) plus optional per-project secrets for `?project=` hooks. */
export interface WebhookSecrets extends SourceSecrets {
  projects?: Record<string, SourceSecrets>;
}

export const hmacHex = (secret: string, body: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Sentry integration webhooks: `sentry-hook-signature` = hex HMAC-SHA256 of the raw body. */
export function verifySentry(secret: string | undefined, body: string, header: string | undefined) {
  return Boolean(secret && header && safeEqual(hmacHex(secret, body), header));
}

/** GitHub webhooks: `x-hub-signature-256` = `sha256=` + hex HMAC-SHA256 of the raw body. */
export function verifyGithub(secret: string | undefined, body: string, header: string | undefined) {
  return Boolean(secret && header && safeEqual(`sha256=${hmacHex(secret, body)}`, header));
}

/**
 * PostHog destinations, OpenTelemetry/Alertmanager receivers and Orca agent hooks can't sign bodies,
 * so they send a shared secret as a bearer token or header, compared in constant time.
 */
export function verifySharedSecret(secret: string | undefined, presented: string | undefined) {
  const token = presented?.startsWith("Bearer ") ? presented.slice(7).trim() : presented?.trim();
  return Boolean(secret && token && safeEqual(secret, token));
}

export function sentryTitle(payload: unknown): {
  title: string;
  fingerprint?: string;
  kind: string;
} {
  const p = payload as {
    action?: string;
    data?: {
      issue?: { title?: string; id?: string };
      event?: { title?: string; issue_id?: string };
    };
  };
  const issue = p.data?.issue;
  const event = p.data?.event;
  const fingerprint = issue?.id ?? event?.issue_id;
  return {
    kind: p.action ?? "event",
    title: issue?.title ?? event?.title ?? "Sentry event",
    ...(fingerprint ? { fingerprint: String(fingerprint) } : {}),
  };
}

export function githubTitle(event: string, payload: unknown): { title: string; kind: string } {
  const p = payload as {
    action?: string;
    workflow_run?: { name?: string; conclusion?: string };
    check_run?: { name?: string; conclusion?: string };
    pull_request?: { title?: string };
    issue?: { title?: string };
  };
  const subject =
    p.workflow_run?.name ?? p.check_run?.name ?? p.pull_request?.title ?? p.issue?.title ?? event;
  const conclusion = p.workflow_run?.conclusion ?? p.check_run?.conclusion;
  return {
    kind: p.action ? `${event}.${p.action}` : event,
    title: conclusion ? `${subject}: ${conclusion}` : subject,
  };
}

export function posthogTitle(payload: unknown): { title: string; kind: string } {
  const p = payload as { event?: { event?: string; properties?: { $exception_message?: string } } };
  return {
    kind: p.event?.event ?? "event",
    title: p.event?.properties?.$exception_message ?? p.event?.event ?? "PostHog event",
  };
}

export function otelTitle(payload: unknown): { title: string; kind: string; fingerprint?: string } {
  const p = payload as {
    status?: string;
    alerts?: { labels?: { alertname?: string }; fingerprint?: string }[];
  };
  const first = p.alerts?.[0];
  return {
    kind: p.status ?? "alert",
    title: first?.labels?.alertname ?? "OpenTelemetry alert",
    ...(first?.fingerprint ? { fingerprint: first.fingerprint } : {}),
  };
}
