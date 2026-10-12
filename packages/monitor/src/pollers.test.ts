import { describe, expect, test } from "vitest";
import glitchtipApi from "./fixtures/glitchtip-api-event.json";
import { normalize } from "./normalize/index.js";
import {
  assertSecureBase,
  MergedSource,
  nextLink,
  PosthogPoller,
  SentryPoller,
} from "./pollers.js";
import type { RawSignal } from "./signal.js";

type Call = { url: string; init?: RequestInit };

function fakeFetch(respond: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), ...(init ? { init } : {}) };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const evt = (id: string, created: string) => ({
  ...glitchtipApi,
  eventID: id,
  event_id: id,
  dateCreated: created,
});

describe("SentryPoller", () => {
  const opts = {
    baseUrl: "https://glitchtip.example.com/",
    token: "t",
    org: "acme",
    project: "api",
    projectId: "ledgerly",
    provider: "glitchtip" as const,
  };

  test("follows pagination until it reaches events older than the cursor", async () => {
    const next = '<https://glitchtip.example.com/api/0/next?cursor=2>; rel="next"; results="true"';
    const { f, calls } = fakeFetch((_c, n) =>
      n === 0
        ? json([evt("e3", "2026-10-12T09:30:00Z"), evt("e2", "2026-10-12T09:20:00Z")], {
            link: next,
          })
        : json([evt("e1", "2026-10-12T09:10:00Z"), evt("old", "2026-10-12T08:00:00Z")], {
            link: next,
          }),
    );
    const out = await new SentryPoller({ ...opts, fetch: f }).pull("2026-10-12T09:00:00Z");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://glitchtip.example.com/api/0/next?cursor=2");
    expect(out.map((r) => (r.payload as { event_id: string }).event_id)).toEqual([
      "e3",
      "e2",
      "e1",
    ]);
    const [s] = normalize(out[0]!, "x");
    expect(s).toMatchObject({ provider: "glitchtip", projectId: "ledgerly" });
  });

  test("a backlog deeper than maxPages is an error, not a silent drop", async () => {
    const next = '<https://glitchtip.example.com/n>; rel="next"; results="true"';
    const { f } = fakeFetch(() =>
      json([evt(`e${Math.random()}`, "2026-10-12T09:30:00Z")], { link: next }),
    );
    await expect(
      new SentryPoller({ ...opts, maxPages: 3, fetch: f }).pull("2026-10-12T09:00:00Z"),
    ).rejects.toThrow("backlog not fully read");
  });

  test("HTTP errors and non-https origins are refused", async () => {
    const { f } = fakeFetch(() => json({ detail: "nope" }, {}, 401));
    await expect(
      new SentryPoller({ ...opts, fetch: f }).pull("2026-10-12T00:00:00Z"),
    ).rejects.toThrow("glitchtip poll 401");
    expect(() => new SentryPoller({ ...opts, baseUrl: "http://sentry.example.com" })).toThrow(
      "non-https",
    );
    expect(assertSecureBase("http://127.0.0.1:9000/")).toBe("http://127.0.0.1:9000");
  });

  test("nextLink only follows pages that have results", () => {
    expect(
      nextLink('<a>; rel="previous"; results="false", <b>; rel="next"; results="false"'),
    ).toBeUndefined();
    expect(nextLink('<a>; rel="previous"; results="false", <b>; rel="next"; results="true"')).toBe(
      "b",
    );
  });
});

describe("PosthogPoller", () => {
  const row = (uuid: string, ts: string) => [
    uuid,
    "$exception",
    "u",
    JSON.stringify({ $exception_list: [] }),
    ts,
  ];

  test("keyset pagination on (timestamp, uuid): equal timestamps at the page boundary aren't skipped", async () => {
    const pages = [
      [row("a", "2026-10-12T09:00:00.000000"), row("b", "2026-10-12T09:00:00.000000")],
      [row("c", "2026-10-12T09:00:00.000000")],
    ];
    const { f, calls } = fakeFetch((_c, n) =>
      json({
        columns: ["uuid", "event", "distinct_id", "properties", "timestamp"],
        results: pages[n] ?? [],
      }),
    );
    const poller = new PosthogPoller({
      baseUrl: "https://eu.posthog.com",
      token: "phx",
      posthogProjectId: "12",
      projectId: "ledgerly",
      pageSize: 2,
      fetch: f,
    });
    const out = await poller.pull("2026-10-12T08:00:00Z");
    expect(out.map((r) => (r.payload as { uuid: string }).uuid)).toEqual(["a", "b", "c"]);
    const second = JSON.parse(String(calls[1]?.init?.body));
    expect(second.query.values).toEqual({ ts: "2026-10-12T09:00:00.000000", id: "b" });
    expect(second.query.query).toContain("ORDER BY timestamp ASC, uuid ASC");
  });
});

describe("MergedSource", () => {
  test("each source keeps its own cursor; a failing source is retried from where it failed", async () => {
    const seen: string[] = [];
    let fail = true;
    const good = {
      pull: async (since: string): Promise<RawSignal[]> => {
        seen.push(`good:${since}`);
        return [
          { source: "otel", kind: "", title: "g", payload: {}, receivedAt: "2026-10-12T10:00:00Z" },
        ];
      },
    };
    const flaky = {
      pull: async (since: string): Promise<RawSignal[]> => {
        seen.push(`flaky:${since}`);
        if (fail) throw new Error("timeout");
        return [];
      },
    };
    const merged = new MergedSource([good, flaky]);
    expect((await merged.pull("2026-10-12T09:00:00Z")).map((r) => r.title)).toEqual(["g"]);
    expect(merged.drainErrors()).toEqual(["source 1: timeout"]);
    expect(merged.drainErrors()).toEqual([]);

    fail = false;
    await merged.pull("2026-10-12T10:00:00Z");
    expect(seen).toEqual([
      "good:2026-10-12T09:00:00Z",
      "flaky:2026-10-12T09:00:00Z",
      "good:2026-10-12T10:00:00Z",
      "flaky:2026-10-12T09:00:00Z",
    ]);
  });
});
