import { mkdir, mkdtemp, readdir, symlink } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BlockedUrlError, getText, isBlockedAddress } from "./http.js";
import { runWatch } from "./run.js";
import { defaultTransport, type PinnedRequest, type Transport } from "./transport.js";

let server: http.Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits += 1;
    res.end("loopback-secret");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("P1-4 reproduced: IPv4-mapped IPv6 in hex form", () => {
  test.each([
    "http://[::ffff:127.0.0.1]:PORT/",
    "http://[::ffff:7f00:1]:PORT/",
    "http://[::7f00:1]:PORT/",
    "http://[64:ff9b::7f00:1]:PORT/",
    "http://[2002:7f00:1::]:PORT/",
    "http://0x7f.1:PORT/",
    "http://2130706433:PORT/",
    "http://0177.0.0.1:PORT/",
  ])("%s never reaches the loopback server", async (template) => {
    const before = hits;
    await expect(getText(template.replace("PORT", String(port)))).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    expect(hits).toBe(before);
  });

  test("tailnet, private and NAT64/6to4-embedded private targets are blocked", () => {
    for (const ip of [
      "::ffff:6440:1",
      "100.90.255.43",
      "2002:0a00:0001::",
      "64:ff9b::a00:1",
      "fd7a:115c:a1e0::1",
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
});

describe("IP pinning", () => {
  test("the connection uses the vetted address, so a rebinding resolver cannot redirect it", async () => {
    let calls = 0;
    const rebinding = async () => (++calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]);
    const seen: PinnedRequest[] = [];
    const recording: Transport = async (req) => {
      seen.push(req);
      return { status: 200, headers: {}, body: new Response("ok").body };
    };
    await expect(
      getText("https://feed.example/rss", { resolve: rebinding, transport: recording }),
    ).resolves.toBe("ok");
    expect(seen.map((r) => r.address)).toEqual(["93.184.216.34"]);
    expect(calls).toBe(1);
  });

  test("the default transport connects to the given address, not to what DNS says", async () => {
    const res = await defaultTransport({
      url: new URL(`http://example.com:${port}/`),
      address: "127.0.0.1",
      method: "GET",
      headers: {},
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(200);
    expect(await new Response(res.body).text()).toBe("loopback-secret");
  });

  test("a redirect to a private address is vetted before connecting", async () => {
    const seen: string[] = [];
    const redirecting: Transport = async (req) => {
      seen.push(req.address);
      return { status: 302, headers: { location: `http://[::ffff:7f00:1]:${port}/` }, body: null };
    };
    await expect(
      getText("https://feed.example/rss", {
        resolve: async () => ["93.184.216.34"],
        transport: redirecting,
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    expect(seen).toEqual(["93.184.216.34"]);
  });
});

test("P1-3 reproduced: a committed .matrix/watch symlink cannot redirect digest or seen-store writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "matrix-watch-root-"));
  const outside = await mkdtemp(join(tmpdir(), "matrix-watch-outside-"));
  await mkdir(join(root, ".matrix"));
  await symlink(outside, join(root, ".matrix", "watch"));
  await expect(
    runWatch({
      root,
      context: { name: "x", stack: [], goals: [], dependencies: [] },
      sources: {
        hn: false,
        feeds: false,
        arxiv: false,
        registry: false,
        releases: false,
        trending: false,
        osv: false,
      },
    }),
  ).rejects.toThrow(/symlink/);
  expect(await readdir(outside)).toEqual([]);
});
