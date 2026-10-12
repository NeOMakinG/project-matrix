import { describe, expect, test } from "vitest";
import glitchtipApi from "./fixtures/glitchtip-api-event.json";
import posthog from "./fixtures/posthog-exception.json";
import { extractJson, GatewayLlm } from "./llm.js";
import { normalize } from "./normalize/index.js";
import { EmailNotifier, MultiNotifier, TelegramNotifier } from "./notify.js";
import { MergedSource, PosthogPoller, SentryPoller } from "./pollers.js";

type Call = { url: string; init?: RequestInit };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), ...(init ? { init } : {}) };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("pollers", () => {
  test("SentryPoller (GlitchTip-compatible) keeps events newer than the cursor", async () => {
    const older = {
      ...glitchtipApi,
      eventID: "old",
      event_id: "old",
      dateCreated: "2026-10-12T08:00:00Z",
    };
    const { f, calls } = fakeFetch(() => json([glitchtipApi, older]));
    const poller = new SentryPoller({
      baseUrl: "https://glitchtip.example.com/",
      token: "t",
      org: "acme",
      project: "ledgerly-api",
      projectId: "ledgerly",
      provider: "glitchtip",
      fetch: f,
    });
    const out = await poller.pull("2026-10-12T09:00:00Z");
    expect(calls[0]?.url).toBe(
      "https://glitchtip.example.com/api/0/projects/acme/ledgerly-api/events/?full=true",
    );
    expect(out).toHaveLength(1);
    const [s] = normalize(out[0]!, "x");
    expect(s).toMatchObject({
      provider: "glitchtip",
      projectId: "ledgerly",
      exceptionType: "ValueError",
    });
  });

  test("PosthogPoller turns HogQL rows into $exception events", async () => {
    const e = posthog.event;
    const { f, calls } = fakeFetch(() =>
      json({
        columns: ["uuid", "event", "distinct_id", "properties", "timestamp"],
        results: [[e.uuid, e.event, e.distinct_id, JSON.stringify(e.properties), e.timestamp]],
      }),
    );
    const poller = new PosthogPoller({
      baseUrl: "https://eu.posthog.com",
      token: "phx",
      posthogProjectId: "12",
      projectId: "ledgerly",
      fetch: f,
    });
    const out = await poller.pull("2026-10-12T09:00:00Z");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.query.kind).toBe("HogQLQuery");
    expect(body.query.query).toContain("event = '$exception'");
    const [s] = normalize(out[0]!, "x");
    expect(s).toMatchObject({
      provider: "posthog",
      exceptionType: "TypeError",
      release: "web@1.4.0",
    });
  });

  test("MergedSource orders by time and pollers fail loudly on HTTP errors", async () => {
    const a = {
      pull: async () => [
        {
          source: "otel" as const,
          kind: "",
          title: "a",
          payload: {},
          receivedAt: "2026-10-12T10:00:00Z",
        },
      ],
    };
    const b = {
      pull: async () => [
        {
          source: "otel" as const,
          kind: "",
          title: "b",
          payload: {},
          receivedAt: "2026-10-12T09:00:00Z",
        },
      ],
    };
    expect((await new MergedSource([a, b]).pull("")).map((r) => r.title)).toEqual(["b", "a"]);

    const { f } = fakeFetch(() => json({ detail: "nope" }, 401));
    const poller = new SentryPoller({
      baseUrl: "https://s",
      token: "t",
      org: "o",
      project: "p",
      projectId: "x",
      fetch: f,
    });
    await expect(poller.pull("2026-10-12T00:00:00Z")).rejects.toThrow("sentry poll 401");
  });
});

describe("notifiers", () => {
  const n = {
    projectId: "ledgerly",
    severity: "high" as const,
    title: "Fix did not hold",
    body: "12/h",
    url: "https://x",
  };

  test("telegram sends a plain-text message to the chat", async () => {
    const { f, calls } = fakeFetch(() => json({ ok: true }));
    await new TelegramNotifier({ botToken: "123:abc", chatId: "42", fetch: f }).notify(n);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toMatchObject({ chat_id: "42" });
    expect(body.text).toBe("[HIGH] ledgerly: Fix did not hold\n12/h\nhttps://x");
  });

  test("multi notifier survives one failing channel, fails when all fail", async () => {
    const sent: string[] = [];
    const email = new EmailNotifier({
      to: "ops@example.com",
      transport: { send: async (m) => void sent.push(m.subject) },
    });
    const broken = { notify: async () => Promise.reject(new Error("down")) };
    await new MultiNotifier([broken, email]).notify(n);
    expect(sent).toEqual(["[HIGH] Fix did not hold"]);
    await expect(new MultiNotifier([broken]).notify(n)).rejects.toThrow(
      "all notification channels failed",
    );
  });
});

describe("gateway llm", () => {
  test("OpenAI-compatible request with temperature 0 and seed; errors surface status", async () => {
    const { f, calls } = fakeFetch(() => json({ choices: [{ message: { content: '{"ok":1}' } }] }));
    const llm = new GatewayLlm({ baseUrl: "http://gw:8317/v1/", apiKey: "k", fetch: f });
    expect(await llm.complete({ model: "m", system: "s", user: "u", maxTokens: 10 })).toBe(
      '{"ok":1}',
    );
    expect(calls[0]?.url).toBe("http://gw:8317/v1/chat/completions");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toMatchObject({ model: "m", temperature: 0, seed: 7, max_tokens: 10 });

    const bad = fakeFetch(() => new Response("cooling down", { status: 429 }));
    const failing = new GatewayLlm({ baseUrl: "http://gw", apiKey: "k", fetch: bad.f });
    await expect(
      failing.complete({ model: "m", system: "s", user: "u", maxTokens: 1 }),
    ).rejects.toThrow("gateway 429: cooling down");
  });

  test("extractJson tolerates fences and prose", () => {
    expect(extractJson('sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":{"b":2}} trailing')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json")).toThrow();
  });
});
