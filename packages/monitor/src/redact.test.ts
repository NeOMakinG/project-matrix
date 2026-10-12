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

describe("redact (PR #5 round 3): passwords with special characters", () => {
  test("reproduced payloads", () => {
    expect(redact("connect postgres://app:pa/ss@db:5432/ledgerly")).toBe(
      "connect postgres://[REDACTED]@db:5432/ledgerly",
    );
    expect(redact("mongodb+srv://u:p#w@cluster0.example.net/prod")).toBe(
      "mongodb+srv://[REDACTED]@cluster0.example.net/prod",
    );
    expect(redact("redis://:rose'bud@cache:6379/0")).toBe("redis://[REDACTED]@cache:6379/0");
  });

  test("two DSNs on one line are redacted separately, an ordinary URL + email is left alone", () => {
    expect(redact("from postgres://a:b@db1/x to redis://c:d@db2")).toBe(
      "from postgres://[REDACTED]@db1/x to redis://[REDACTED]@db2",
    );
    expect(redact("GET https://api.example.com/v1/users failed for ops@example.com")).toBe(
      "GET https://api.example.com/v1/users failed for [EMAIL]",
    );
  });

  test("fuzz: random passwords with hostile characters never survive", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = "abcXYZ0129/#?'\"@:;!$&*()=+%~^ ,.-_[]";
    const schemes = [
      "postgres",
      "postgresql",
      "mysql",
      "redis",
      "rediss",
      "mongodb+srv",
      "amqp",
      "https",
      "ftp",
    ];
    for (let i = 0; i < 2000; i++) {
      const len = 6 + Math.floor(rand() * 18);
      let pw = "";
      for (let j = 0; j < len; j++) pw += alphabet[Math.floor(rand() * alphabet.length)];
      // canary marker that must disappear, wrapped in hostile characters
      const secret = `${pw.slice(0, len / 2)}ZQXcanary${i}${pw.slice(len / 2)}`;
      const scheme = schemes[i % schemes.length];
      const user = rand() < 0.3 ? "" : `user${i}`;
      const line = `error connecting ${scheme}://${user}:${secret}@db-${i}.internal:5432/app?ssl=1`;
      const out = redact(line);
      expect(out, line).not.toContain(`ZQXcanary${i}`);
      expect(out, line).toContain(`${scheme}://[REDACTED]@`);
    }
  });
});

test("documented trade-off: host:port followed by an email on the same line is over-redacted", () => {
  expect(redact("http://localhost:3000 is down, mail me@example.com")).toBe(
    "http://[REDACTED]@example.com",
  );
  // without a port the URL survives
  expect(redact("http://localhost is down, mail me@example.com")).toBe(
    "http://localhost is down, mail [EMAIL]",
  );
});
