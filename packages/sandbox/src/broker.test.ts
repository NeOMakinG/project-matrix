import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CredentialBroker, hostAllowed } from "./broker";
import { isPrivateAddress } from "./ip";

const REAL_KEY = "real-gateway-key-abcdef123456";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function upstream(): Promise<{ url: string; seen: http.IncomingHttpHeaders[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ path: req.url, body })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise((r) => server.close(() => r())));
  const { port } = server.address() as net.AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

function request(
  socketPath: string,
  options: http.RequestOptions,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, ...options }, (res) => {
      let data = "";
      res.on("data", (c) => {
        data += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function broker(url: string) {
  const b = new CredentialBroker({ gatewayUrl: url, gatewayKey: { value: REAL_KEY } });
  cleanups.push(() => b.closeAll());
  return b;
}

describe("llm socket", () => {
  test("forwards allowed routes with the real key, never the run token", async () => {
    const up = await upstream();
    const grant = await (await broker(up.url)).grant({ runId: "run-1", network: "gateway" });
    const res = await request(
      join(grant.socketDir ?? "", "llm.sock"),
      {
        method: "POST",
        path: "/v1/messages",
        headers: { "x-api-key": grant.token, "content-type": "application/json" },
      },
      '{"hi":1}',
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain('"path":"/v1/messages"');
    expect(res.body).toContain("[DONE]");
    expect(up.seen[0]?.["x-api-key"]).toBe(REAL_KEY);
    expect(up.seen[0]?.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(JSON.stringify(up.seen)).not.toContain(grant.token);
  });

  test("rejects unknown routes and wrong tokens without forwarding", async () => {
    const up = await upstream();
    const grant = await (await broker(up.url)).grant({ runId: "run-2", network: "gateway" });
    const sock = join(grant.socketDir ?? "", "llm.sock");
    expect(
      (
        await request(sock, {
          method: "GET",
          path: "/v0/management/keys",
          headers: { "x-api-key": grant.token },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(sock, {
          method: "POST",
          path: "/v1/messages",
          headers: { authorization: "Bearer nope" },
        })
      ).status,
    ).toBe(401);
    expect(up.seen).toHaveLength(0);
  });

  test("network none opens no sockets; grants close their directory", async () => {
    const up = await upstream();
    const b = await broker(up.url);
    expect((await b.grant({ runId: "run-3", network: "none" })).socketDir).toBeUndefined();
    const grant = await b.grant({ runId: "run-4", network: "gateway" });
    await grant.close();
    await expect(
      request(join(grant.socketDir ?? "", "llm.sock"), { method: "GET", path: "/v1/models" }),
    ).rejects.toThrow();
  });
});

describe("egress socket", () => {
  async function connect(socketPath: string, target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const s = net.connect(socketPath, () =>
        s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
      );
      let data = "";
      s.on("data", (c) => {
        data += c.toString();
        if (data.includes("\r\n\r\n")) {
          s.destroy();
          resolve(data.split("\r\n")[0] ?? "");
        }
      });
      s.on("error", reject);
    });
  }

  test("tunnels only to allowlisted host:port", async () => {
    const target = net.createServer((c) => c.end());
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise((r) => target.close(() => r())));
    const port = (target.address() as net.AddressInfo).port;
    const up = await upstream();
    const grant = await (await broker(up.url)).grant({
      runId: "run-5",
      network: "allowlist",
      allowHosts: ["127.0.0.1"],
      allowPorts: [port],
      allowPrivate: true,
    });
    const sock = join(grant.socketDir ?? "", "egress.sock");
    expect(await connect(sock, `127.0.0.1:${port}`)).toContain("200");
    expect(await connect(sock, "evil.example.com:443")).toContain("403");
    expect(await connect(sock, `127.0.0.1:${port + 1}`)).toContain("403");
  });
});

test("hostAllowed handles wildcards without matching lookalikes", () => {
  expect(hostAllowed("registry.npmjs.org", ["registry.npmjs.org"])).toBe(true);
  expect(hostAllowed("a.github.com", ["*.github.com"])).toBe(true);
  expect(hostAllowed("github.com", ["*.github.com"])).toBe(false);
  expect(hostAllowed("evilgithub.com", ["*.github.com"])).toBe(false);
  expect(hostAllowed("registry.npmjs.org.evil.com", ["registry.npmjs.org"])).toBe(false);
});

test("allowlisted names that resolve to private addresses are refused", async () => {
  const up = await upstream();
  const grant = await (await broker(up.url)).grant({
    runId: "run-6",
    network: "allowlist",
    allowHosts: ["localhost"],
    allowPorts: [443],
  });
  const reply = await new Promise<string>((resolve, reject) => {
    const s = net.connect(join(grant.socketDir ?? "", "egress.sock"), () =>
      s.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n"),
    );
    s.on("data", (c) => {
      s.destroy();
      resolve(c.toString().split("\r\n")[0] ?? "");
    });
    s.on("error", reject);
  });
  expect(reply).toContain("403");
});

test("private address classification", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "100.90.255.43",
    "169.254.169.254",
    "172.20.0.1",
    "192.168.1.1",
    "::1",
    "fd7a:115c:a1e0::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "0.0.0.0",
  ]) {
    expect(isPrivateAddress(ip), ip).toBe(true);
  }
  for (const ip of ["1.1.1.1", "104.16.1.1", "2606:4700::1111"])
    expect(isPrivateAddress(ip), ip).toBe(false);
});
