import { describe, expect, test } from "vitest";
import { redact } from "./redact.js";

describe("redact (PR #5 round 2)", () => {
  test("URL userinfo and DSN credentials, reproduced payloads", () => {
    const cases: [string, string][] = [
      [
        "fetch https://admin:hunter2@api.example.com/v1/x failed",
        "fetch https://[REDACTED]@api.example.com/v1/x failed",
      ],
      [
        "connect postgres://app:pg-s3cret@db.internal:5432/ledgerly",
        "connect postgres://[REDACTED]@db.internal:5432/ledgerly",
      ],
      ["mysql://root:toor@10.0.0.5/app", "mysql://[REDACTED]@[IP]/app"],
      ["redis://:r3dispass@cache:6379/0", "redis://[REDACTED]@cache:6379/0"],
      [
        "mongodb+srv://svc:m0ngo@cluster0.ab1cd.mongodb.net/prod",
        "mongodb+srv://[REDACTED]@cluster0.ab1cd.mongodb.net/prod",
      ],
      ["amqp://guest:guestpw@rabbit:5672/vhost", "amqp://[REDACTED]@rabbit:5672/vhost"],
      ["postgres://u:p@db/x?sslmode=require&password=leak", "postgres://[REDACTED]@db/x"],
    ];
    for (const [input, expected] of cases) {
      const out = redact(input);
      expect(out, input).toBe(expected);
      for (const secret of [
        "hunter2",
        "pg-s3cret",
        "toor",
        "r3dispass",
        "m0ngo",
        "guestpw",
        "leak",
      ]) {
        expect(out).not.toContain(secret);
      }
    }
  });

  test("phone numbers are masked without touching line numbers, versions or timestamps", () => {
    expect(redact("call +33 6 74 58 67 28 or +14155550123")).toBe("call [PHONE] or [PHONE]");
    expect(redact("rappel au 06 74 58 67 28 / (020) 7946 0958")).toBe(
      "rappel au [PHONE] / [PHONE]",
    );
    for (const keep of [
      "src/billing/totals.ts:17:42",
      "web@1.4.0",
      "2026-10-12T10:13:21.000Z",
      "HTTP 502 after 1500 ms",
      "order 1234567",
    ]) {
      expect(redact(keep), keep).not.toContain("[PHONE]");
    }
  });
});
