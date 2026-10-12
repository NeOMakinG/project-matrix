import { describe, expect, test } from "vitest";
import glitchtipApi from "./fixtures/glitchtip-api-event.json";
import glitchtipHook from "./fixtures/glitchtip-webhook.json";
import otel from "./fixtures/otel-alertmanager.json";
import posthog from "./fixtures/posthog-exception.json";
import sentryEvent from "./fixtures/sentry-event.json";
import sentryIssue from "./fixtures/sentry-issue.json";
import kumaDown from "./fixtures/uptime-kuma-down.json";
import kumaUp from "./fixtures/uptime-kuma-up.json";
import { normalize } from "./normalize/index.js";
import { raw } from "./testing.js";

describe("normalize", () => {
  test("sentry event webhook: frames crash-site first, release, user", () => {
    const [s] = normalize(raw("sentry", sentryEvent), "ledgerly");
    expect(s).toMatchObject({
      id: "sentry:a1b2c3d4e5f60718293a4b5c6d7e8f90",
      provider: "sentry",
      projectId: "ledgerly",
      kind: "error",
      level: "error",
      exceptionType: "TypeError",
      release: "web@1.4.0",
      environment: "production",
      providerFingerprint: "4815162342",
      users: 1,
      occurredAt: "2026-10-12T10:13:20.123Z",
    });
    expect(s?.frames[0]).toEqual({
      file: "src/billing/totals.ts",
      function: "invoiceTotal",
      line: 17,
      inApp: true,
    });
    expect(s?.frames.at(-1)?.inApp).toBe(false);
  });

  test("sentry issue webhook: counts and users from the issue", () => {
    const [s] = normalize(raw("sentry", sentryIssue), "ledgerly");
    expect(s).toMatchObject({ count: 37, users: 12, providerFingerprint: "4815162342" });
    expect(s?.frames).toEqual([]);
  });

  test("glitchtip slack-style webhook", () => {
    const [s] = normalize(raw("glitchtip", glitchtipHook), "ledgerly");
    expect(s).toMatchObject({
      provider: "glitchtip",
      title: "ValueError: invalid currency code 'XXX'",
      release: "api@2.1.0",
      environment: "production",
      providerFingerprint: "913",
      url: "https://glitchtip.example.com/acme/issues/913",
    });
  });

  test("glitchtip API event uses the sentry format", () => {
    const [s] = normalize(raw("glitchtip", glitchtipApi), "ledgerly");
    expect(s?.provider).toBe("glitchtip");
    expect(s?.frames.map((f) => f.file)).toEqual([
      "api/billing/convert.ts",
      "api/routes/invoices.ts",
    ]);
  });

  test("posthog $exception", () => {
    const [s] = normalize(raw("posthog", posthog), "ledgerly");
    expect(s).toMatchObject({
      id: "posthog:01929f2a-7c11-7b8e-9d2e-4f3a2b1c0d9e",
      exceptionType: "TypeError",
      release: "web@1.4.0",
      providerFingerprint: "ph-9c41b2",
      users: 1,
    });
    expect(s?.frames[0]?.file).toBe("src/billing/totals.ts");
  });

  test("otel alertmanager: firing only, labels merged", () => {
    const signals = normalize(raw("otel", otel), "ledgerly");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "alert",
      level: "fatal",
      title: "5xx rate above 5% on POST /invoices",
      release: "api@2.1.0",
      environment: "production",
      providerFingerprint: "HighErrorRate:ledgerly-api",
    });
  });

  test("uptime kuma: down becomes a fatal downtime signal in UTC, up is dropped", () => {
    const [s] = normalize(raw("uptime", kumaDown), "ledgerly");
    expect(s).toMatchObject({
      kind: "downtime",
      level: "fatal",
      title: "ledgerly web is down",
      message: "Request failed with status code 502",
      occurredAt: "2026-10-12T09:20:00.000Z",
    });
    expect(normalize(raw("uptime", kumaUp), "ledgerly")).toEqual([]);
  });

  test("github events are ignored and envelope projectId wins", () => {
    expect(normalize(raw("github", {}), "ledgerly")).toEqual([]);
    const [s] = normalize({ ...raw("sentry", sentryEvent), projectId: "other" }, "ledgerly");
    expect(s?.projectId).toBe("other");
  });

  test("garbage payloads still produce valid signals", () => {
    const [s] = normalize(raw("sentry", { nonsense: true }), "ledgerly");
    expect(s?.title).toBe("sentry signal");
    expect(s?.frames).toEqual([]);
  });
});
