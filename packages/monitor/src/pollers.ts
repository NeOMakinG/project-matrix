import type { RawSignal, SignalSource } from "./signal.js";

type Fetch = typeof fetch;

const DEFAULT_TIMEOUT = 30_000;
const MAX_PAGES = 20;

/** Bearer tokens only go over https (plain http allowed for loopback only). */
export function assertSecureBase(baseUrl: string): string {
  const u = new URL(baseUrl);
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new Error(`refusing to send credentials to non-https origin ${u.origin}`);
  }
  return u.toString().replace(/\/$/, "");
}

/** `<url>; rel="next"; results="true"` (Sentry Link header). */
export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const url = part.match(/<([^>]+)>/)?.[1];
    if (url && /rel="next"/.test(part) && /results="true"/.test(part)) return url;
  }
  return undefined;
}

export interface SentryPollerOptions {
  /** e.g. https://sentry.io or a self-hosted GlitchTip URL (Sentry-compatible API). */
  baseUrl: string;
  token: string;
  org: string;
  project: string;
  projectId: string;
  provider?: "sentry" | "glitchtip";
  timeoutMs?: number;
  maxPages?: number;
  fetch?: Fetch;
}

/**
 * Pulls events newer than `since` from the project events API (newest first), following
 * pagination until it reaches older events. Throws if it runs out of pages before that,
 * so a backlog is reported instead of silently dropped.
 */
export class SentryPoller implements SignalSource {
  private readonly base: string;
  constructor(private readonly o: SentryPollerOptions) {
    this.base = assertSecureBase(o.baseUrl);
  }

  async pull(since: string): Promise<RawSignal[]> {
    const doFetch = this.o.fetch ?? fetch;
    const provider = this.o.provider ?? "sentry";
    const sinceMs = Date.parse(since);
    const out: RawSignal[] = [];
    let url: string | undefined =
      `${this.base}/api/0/projects/${encodeURIComponent(this.o.org)}/${encodeURIComponent(this.o.project)}/events/?full=true`;
    for (let page = 0; url; page++) {
      if (page >= (this.o.maxPages ?? MAX_PAGES)) {
        throw new Error(
          `${provider} poll: more than ${page} pages since ${since}; backlog not fully read`,
        );
      }
      const res = await doFetch(url, {
        headers: { authorization: `Bearer ${this.o.token}` },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? DEFAULT_TIMEOUT),
      });
      if (!res.ok) throw new Error(`${provider} poll ${res.status}`);
      const events = (await res.json()) as Record<string, unknown>[];
      let reachedOlder = false;
      for (const e of events) {
        const created = String(e.dateCreated ?? e.dateReceived ?? e.datetime ?? "");
        if (!created) continue;
        if (Date.parse(created) < sinceMs) {
          reachedOlder = true;
          continue;
        }
        out.push({
          source: provider,
          kind: "event",
          projectId: this.o.projectId,
          title: String(e.title ?? "event"),
          payload: { ...e, timestamp: created },
          receivedAt: created,
        });
      }
      url = reachedOlder ? undefined : nextLink(res.headers.get("link"));
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
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
  fetch?: Fetch;
}

/**
 * Pulls `$exception` events through the PostHog HogQL query API, keyset-paginated on
 * (timestamp, uuid) so events sharing a timestamp at a page boundary are never skipped.
 */
export class PosthogPoller implements SignalSource {
  private readonly base: string;
  constructor(private readonly o: PosthogPollerOptions) {
    this.base = assertSecureBase(o.baseUrl);
  }

  async pull(since: string): Promise<RawSignal[]> {
    const doFetch = this.o.fetch ?? fetch;
    const size = Math.min(this.o.pageSize ?? 500, 1000);
    const out: RawSignal[] = [];
    let afterTs = since.replace("Z", "");
    let afterId = "";
    for (let page = 0; ; page++) {
      if (page >= (this.o.maxPages ?? MAX_PAGES)) {
        throw new Error(
          `posthog poll: more than ${page} pages since ${since}; backlog not fully read`,
        );
      }
      const query = `SELECT uuid, event, distinct_id, properties, timestamp FROM events WHERE event = '$exception' AND (timestamp > toDateTime64({ts}, 6) OR (timestamp = toDateTime64({ts}, 6) AND toString(uuid) > {id})) ORDER BY timestamp ASC, uuid ASC LIMIT ${size}`;
      const res = await doFetch(
        `${this.base}/api/projects/${encodeURIComponent(this.o.posthogProjectId)}/query/`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            query: { kind: "HogQLQuery", query, values: { ts: afterTs, id: afterId } },
          }),
          signal: AbortSignal.timeout(this.o.timeoutMs ?? DEFAULT_TIMEOUT),
        },
      );
      if (!res.ok) throw new Error(`posthog poll ${res.status}`);
      const body = (await res.json()) as { columns?: string[]; results?: unknown[][] };
      const cols = body.columns ?? [];
      const rows = body.results ?? [];
      for (const row of rows) {
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
        out.push({
          source: "posthog",
          kind: "$exception",
          projectId: this.o.projectId,
          title: "$exception",
          payload: event,
          receivedAt: String(event.timestamp ?? since),
        });
        afterTs = String(event.timestamp ?? afterTs).replace("Z", "");
        afterId = String(event.uuid ?? afterId);
      }
      if (rows.length < size) return out;
    }
  }
}

/**
 * Combines sources, each with its own cursor: a failing source keeps its cursor (and is retried
 * from there next time) while the others advance. Failures are reported through drainErrors().
 */
export class MergedSource implements SignalSource {
  private readonly cursors: (string | undefined)[];
  private errors: string[] = [];

  constructor(private readonly sources: SignalSource[]) {
    this.cursors = sources.map(() => undefined);
  }

  async pull(since: string): Promise<RawSignal[]> {
    const settled = await Promise.allSettled(
      this.sources.map((s, i) => {
        const own = this.cursors[i];
        const from = own && Date.parse(own) < Date.parse(since) ? own : since;
        return s.pull(from);
      }),
    );
    const out: RawSignal[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        out.push(...r.value);
        this.errors.push(...(this.sources[i]?.drainErrors?.() ?? []));
        this.cursors[i] = undefined;
      } else {
        // Keep the earliest cursor this source still owes us.
        this.cursors[i] ??= since;
        this.errors.push(
          `source ${i}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        );
      }
    });
    return out.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  }

  drainErrors(): string[] {
    const e = this.errors;
    this.errors = [];
    return e;
  }
}
