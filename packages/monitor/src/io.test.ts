import { describe, expect, test } from "vitest";
import { extractJson, GatewayLlm } from "./llm.js";
import { EmailNotifier, MultiNotifier, TelegramNotifier } from "./notify.js";

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

describe("notification hardening", () => {
  test("CR/LF in titles can't forge lines or email headers", async () => {
    const sent: { subject: string; text: string }[] = [];
    const email = new EmailNotifier({
      to: "ops@example.com",
      transport: { send: async (m) => void sent.push(m) },
    });
    await email.notify({
      projectId: "p",
      severity: "low",
      title: "x\r\nBcc: evil@example.com",
      body: "b",
    });
    expect(sent[0]?.subject).toBe("[LOW] x Bcc: evil@example.com");
    expect(sent[0]?.text.split("\n")[0]).toBe("[LOW] p: x Bcc: evil@example.com");
  });
});
