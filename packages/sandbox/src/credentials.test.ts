import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { matchKeyLine, resolveCredential } from "./credentials.js";

const CONFIG = [
  "model:",
  "  provider: custom",
  "  api_key: fake-key-123",
  "  base_url: http://127.0.0.1:8317/v1",
  "",
].join("\n");

test("a key-file pattern applies per line and never glues the next line onto the key", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "matrix-cred-")), "config.yaml");
  writeFileSync(file, CONFIG);
  // `[^ ]+` also matches newlines: applied to the whole file it ran into `base_url:`.
  for (const pattern of [/^ *api_key: *([^ ]+)/m, /^ *api_key: *([^ ]+)/, /api_key:\s*(\S+)/gs])
    expect(await resolveCredential({ file, pattern })).toBe("fake-key-123");
});

test("CRLF, quotes and trailing spaces are trimmed; no match is an error", async () => {
  expect(matchKeyLine('a: 1\r\napi_key: "fake-key-9"  \r\nb: 2', /api_key: *(.+)/)).toBe(
    '"fake-key-9"',
  );
  const file = join(mkdtempSync(join(tmpdir(), "matrix-cred-")), "config.yaml");
  writeFileSync(file, 'x: 1\r\napi_key: "fake-key-9"  \r\n');
  expect(await resolveCredential({ file, pattern: /api_key: *(.+)/ })).toBe("fake-key-9");
  writeFileSync(file, "nothing here\n");
  await expect(resolveCredential({ file, pattern: /api_key: *(\S+)/ })).rejects.toThrow(
    "credential source resolved to an empty value",
  );
});

test("the first matching line wins and empty captures are skipped", () => {
  expect(matchKeyLine("api_key:\napi_key: k2", /api_key:(?: *(\S+))?/)).toBe("k2");
  expect(matchKeyLine("api_key:\napi_key: second\napi_key: third", /api_key: *(\S*)/)).toBe(
    "second",
  );
});
