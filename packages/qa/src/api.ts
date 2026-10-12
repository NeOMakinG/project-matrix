import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Receipt } from "@matrix/core";
import { fileReceipt, slug } from "./receipts.js";

export interface ApiExpectation {
  status?: number | number[];
  bodyIncludes?: string[];
  json?: (value: unknown) => boolean | string;
  maxMs?: number;
}

export interface ApiCheck {
  name: string;
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | object;
  expect: ApiExpectation;
  timeoutMs?: number;
}

export const MAX_RESPONSE_BYTES = 1024 * 1024;

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      chunks.push(value.subarray(0, value.length - (size - max)));
      return `${Buffer.concat(chunks).toString("utf8")}\n[response truncated at ${max} bytes]`;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const SECRET_HEADERS = /^(authorization|x-api-key|cookie|set-cookie|proxy-authorization)$/i;

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, SECRET_HEADERS.test(k) ? "[redacted]" : v]),
  );
}

/** Runs one HTTP check and writes a curl-like transcript (secrets redacted) as the receipt artifact. */
export async function runApiCheck(
  check: ApiCheck,
  outDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Receipt> {
  await mkdir(outDir, { recursive: true });
  const method = check.method ?? (check.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { ...(check.headers ?? {}) };
  let body: string | undefined;
  if (check.body !== undefined) {
    body = typeof check.body === "string" ? check.body : JSON.stringify(check.body);
    if (typeof check.body !== "string") headers["content-type"] ??= "application/json";
  }
  const started = performance.now();
  const problems: string[] = [];
  let status = 0;
  let responseText = "";
  let responseHeaders: Record<string, string> = {};
  try {
    const res = await fetchImpl(check.url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(check.timeoutMs ?? 30_000),
    });
    status = res.status;
    responseHeaders = Object.fromEntries(res.headers.entries());
    responseText = await readCapped(res, MAX_RESPONSE_BYTES);
  } catch (error) {
    problems.push(`request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ms = Math.round(performance.now() - started);
  const { expect } = check;
  if (status) {
    const allowed = expect.status === undefined ? [200] : [expect.status].flat();
    if (!allowed.includes(status)) problems.push(`status ${status}, expected ${allowed.join("|")}`);
    for (const needle of expect.bodyIncludes ?? [])
      if (!responseText.includes(needle)) problems.push(`body lacks ${JSON.stringify(needle)}`);
    if (expect.json) {
      try {
        const verdict = expect.json(JSON.parse(responseText));
        if (verdict !== true)
          problems.push(typeof verdict === "string" ? verdict : "json assertion failed");
      } catch {
        problems.push("response is not JSON");
      }
    }
    if (expect.maxMs !== undefined && ms > expect.maxMs)
      problems.push(`took ${ms}ms > ${expect.maxMs}ms`);
  }
  const transcript = [
    `> ${method} ${check.url}`,
    ...Object.entries(redactHeaders(headers)).map(([k, v]) => `> ${k}: ${v}`),
    ...(body !== undefined ? [">", body] : []),
    "",
    `< ${status || "no response"} (${ms}ms)`,
    ...Object.entries(redactHeaders(responseHeaders)).map(([k, v]) => `< ${k}: ${v}`),
    "<",
    responseText.slice(0, 64 * 1024),
    "",
    problems.length ? `FAIL: ${problems.join("; ")}` : "PASS",
  ].join("\n");
  const path = join(outDir, `curl-${slug(check.name)}.txt`);
  await writeFile(path, transcript, "utf8");
  const ok = problems.length === 0;
  return fileReceipt(
    "curl",
    path,
    `${method} ${new URL(check.url).pathname} ${status || "error"}${ok ? "" : ` — ${problems.join("; ")}`}`,
    ok,
    {
      status,
      ms,
    },
  );
}
