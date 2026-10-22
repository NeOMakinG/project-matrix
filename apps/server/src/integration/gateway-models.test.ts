import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGatewayUnavailable } from "@matrix/core";
import { afterEach, describe, expect, test } from "vitest";
import { servedModels } from "./gateway-models.js";
import { gatewayModels } from "./model-plan.js";

const HOUR = 60 * 60_000;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function lister(answers: (string[] | undefined)[]) {
  const calls = { n: 0 };
  const list = async () => {
    const answer = answers[Math.min(calls.n++, answers.length - 1)];
    return answer;
  };
  return { list, calls };
}

describe("servedModels", () => {
  test("serves a stale list while the gateway is down, refuses past the stale window", async () => {
    let t = 0;
    const { list, calls } = lister([["m1"], undefined]);
    const served = servedModels(list, { now: () => t, ttlMs: 60_000, staleMs: 24 * HOUR });
    await served.assert("m1");
    t = 2 * HOUR; // expired: answered from cache, revalidated in the background (fails)
    await served.assert("m1");
    expect(await served.ready("m1")).toBeNull();
    expect(calls.n).toBe(2);
    t = 25 * HOUR;
    const error = await served.assert("m1").catch((e: Error) => e);
    expect(isGatewayUnavailable(String(error))).toBe(true);
    expect(await served.ready("m1")).toMatch(/gateway unavailable/);
  });

  test("cold start with the gateway down is unavailable; unserved ids are refused, not deferred", async () => {
    let t = 0;
    const { list, calls } = lister([undefined, ["m1"]]);
    const served = servedModels(list, { now: () => t, retryMs: 1_000 });
    await expect(served.assert("m1")).rejects.toThrow(
      /^cannot verify model m1: gateway unavailable/,
    );
    t = 2_000;
    await served.assert("m1");
    await expect(served.assert("other")).rejects.toThrow("is not served by the gateway");
    expect(await served.ready("other")).toBeNull();
    // A fresh list is authoritative: no refetch per call for an unserved id.
    expect(calls.n).toBe(2);
  });

  test("the preflight never waits on the gateway; its background fetch serves the next tick", async () => {
    let release: (ids: string[]) => void = () => {};
    const list = () => new Promise<string[]>((resolve) => (release = resolve));
    const served = servedModels(list);
    expect(await served.ready("m1")).toMatch(/gateway unavailable/);
    release(["m1"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await served.ready("m1")).toBeNull();
  });

  test("a failed fetch opens a backoff window with no new gateway calls", async () => {
    let t = 0;
    const { list, calls } = lister([undefined]);
    const served = servedModels(list, { now: () => t, retryMs: 10_000 });
    await served.assert("m1").catch(() => undefined);
    await served.assert("m1").catch(() => undefined);
    expect(await served.ready("m1")).toMatch(/gateway unavailable/);
    expect(calls.n).toBe(1);
    t = 10_001;
    await served.assert("m1").catch(() => undefined);
    expect(calls.n).toBe(2);
  });

  test("the last good list survives a restart through the cache file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-models-"));
    dirs.push(dir);
    const cacheFile = join(dir, "gateway-models.json");
    let t = 1_000;
    const cacheKey = "gw-a";
    await servedModels(lister([["m1", "m2"]]).list, { now: () => t, cacheFile, cacheKey }).assert(
      "m1",
    );
    expect(JSON.parse(await readFile(cacheFile, "utf8"))).toEqual({
      at: 1_000,
      ids: ["m1", "m2"],
      key: "gw-a",
    });
    t = 3 * HOUR;
    const restarted = servedModels(lister([undefined]).list, { now: () => t, cacheFile, cacheKey });
    expect(await restarted.ready("m2")).toBeNull();
    // Another gateway never trusts this list.
    const other = servedModels(lister([undefined]).list, {
      now: () => t,
      cacheFile,
      cacheKey: "gw-b",
    });
    expect(await other.ready("m2")).toMatch(/gateway unavailable/);
  });
});

describe("gatewayModels", () => {
  const ok = () => new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });

  test("retries once on a timeout or 5xx", async () => {
    for (const first of [
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      () => Promise.resolve(new Response("", { status: 503 })),
    ]) {
      let n = 0;
      const fetcher = (async () => (n++ === 0 ? first() : ok())) as unknown as typeof fetch;
      expect(await gatewayModels("http://gw/v1", "k", fetcher)()).toEqual(["m1"]);
      expect(n).toBe(2);
    }
  });

  test("a 4xx is final and two failures give up", async () => {
    let n = 0;
    const denied = (async () => {
      n++;
      return new Response("", { status: 401 });
    }) as unknown as typeof fetch;
    expect(await gatewayModels("http://gw/v1", "k", denied)()).toBeUndefined();
    expect(n).toBe(1);
    n = 0;
    const down = (async () => {
      n++;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await gatewayModels("http://gw/v1", "k", down)()).toBeUndefined();
    expect(n).toBe(2);
    n = 0;
    const malformed = (async () => {
      n++;
      return new Response("not json", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await gatewayModels("http://gw/v1", "k", malformed)()).toBeUndefined();
    expect(n).toBe(1);
  });
});
