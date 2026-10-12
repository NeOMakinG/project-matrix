import type { RawSignal, SignalSource } from "./signal.js";

type Fetch = typeof fetch;

export interface SentryPollerOptions {
  /** e.g. https://sentry.io or a self-hosted GlitchTip URL (Sentry-compatible API). */
  baseUrl: string;
  token: string;
  org: string;
  project: string;
  projectId: string;
  provider?: "sentry" | "glitchtip";
  fetch?: Fetch;
}

/** Pulls recent events from the Sentry (or GlitchTip) project events API. */
export class SentryPoller implements SignalSource {
  constructor(private readonly o: SentryPollerOptions) {}

  async pull(since: string): Promise<RawSignal[]> {
    const doFetch = this.o.fetch ?? fetch;
    const url = `${this.o.baseUrl.replace(/\/$/, "")}/api/0/projects/${encodeURIComponent(this.o.org)}/${encodeURIComponent(this.o.project)}/events/?full=true`;
    const res = await doFetch(url, { headers: { authorization: `Bearer ${this.o.token}` } });
    if (!res.ok) throw new Error(`${this.o.provider ?? "sentry"} poll ${res.status}`);
    const events = (await res.json()) as Record<string, unknown>[];
    const sinceMs = Date.parse(since);
    const out: RawSignal[] = [];
    for (const e of events) {
      const created = String(e.dateCreated ?? e.dateReceived ?? e.datetime ?? "");
      if (!created || Date.parse(created) <= sinceMs) continue;
      out.push({
        source: this.o.provider ?? "sentry",
        kind: "event",
        projectId: this.o.projectId,
        title: String(e.title ?? "event"),
        payload: { ...e, timestamp: created },
        receivedAt: created,
      });
    }
    return out;
  }
}

export interface PosthogPollerOptions {
  baseUrl: string;
  /** Personal API key with query:read. */
  token: string;
  posthogProjectId: string;
  projectId: string;
  limit?: number;
  fetch?: Fetch;
}

/** Pulls `$exception` events through the PostHog HogQL query API. */
export class PosthogPoller implements SignalSource {
  constructor(private readonly o: PosthogPollerOptions) {}

  async pull(since: string): Promise<RawSignal[]> {
    const doFetch = this.o.fetch ?? fetch;
    const limit = Math.min(this.o.limit ?? 500, 1000);
    const query = `SELECT uuid, event, distinct_id, properties, timestamp FROM events WHERE event = '$exception' AND timestamp > toDateTime({since}) ORDER BY timestamp ASC LIMIT ${limit}`;
    const res = await doFetch(
      `${this.o.baseUrl.replace(/\/$/, "")}/api/projects/${encodeURIComponent(this.o.posthogProjectId)}/query/`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          query: { kind: "HogQLQuery", query, values: { since: since.replace("Z", "") } },
        }),
      },
    );
    if (!res.ok) throw new Error(`posthog poll ${res.status}`);
    const body = (await res.json()) as { columns?: string[]; results?: unknown[][] };
    const cols = body.columns ?? [];
    return (body.results ?? []).map((row) => {
      const event: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        event[c] = row[i];
      });
      if (typeof event.properties === "string") {
        try {
          event.properties = JSON.parse(event.properties);
        } catch {
          event.properties = {};
        }
      }
      return {
        source: "posthog" as const,
        kind: "$exception",
        projectId: this.o.projectId,
        title: "$exception",
        payload: event,
        receivedAt: String(event.timestamp ?? since),
      };
    });
  }
}

/** Combines several sources (server webhook store + pollers). */
export class MergedSource implements SignalSource {
  constructor(private readonly sources: SignalSource[]) {}

  async pull(since: string): Promise<RawSignal[]> {
    const all = await Promise.all(this.sources.map((s) => s.pull(since)));
    return all.flat().sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  }
}
