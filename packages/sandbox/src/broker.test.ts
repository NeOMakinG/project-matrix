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

async function upstream(
  redirectTo?: string,
): Promise<{ url: string; seen: http.IncomingHttpHeaders[]; paths: string[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    paths.push(req.url ?? "");
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      if (redirectTo) {
        res.writeHead(302, { location: redirectTo });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ path: req.url, body })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  cleanups.push(() => new Promise((r) => server.close(() => r())));
  const { port } = server.address() as net.AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, paths };
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
  test("normalizes origin and v1 bases through the actual proxy, retaining custom mounts and queries", async () => {
    const up = await upstream();
    const bases = [
      "",
      "/",
      "/v1",
      "/v1/",
      "/hermes",
      "/hermes/",
      "/hermes/v1",
      "/hermes/v1/",
      "/proxy/hermes/v1/",
    ];
    for (const [index, base] of bases.entries()) {
      const grant = await (await broker(`${up.url}${base}`)).grant({
        runId: `normalization-${index}`,
        network: "gateway",
      });
      const socket = join(grant.socketDir ?? "", "llm.sock");
      const mount = base.startsWith("/proxy/")
        ? "/proxy/hermes"
        : base.startsWith("/hermes")
          ? "/hermes"
          : "";
      for (const path of ["/v1/responses", "/v1/messages", "/v1/models"]) {
        const original = `${path}?trace=fixture%2Fvalue&keep=a%2Bb`;
        const response = await request(socket, {
          method: path.endsWith("models") ? "GET" : "POST",
          path: original,
          headers: {
            authorization: `Bearer ${grant.token}`,
            "x-api-key": grant.token,
            "proxy-authorization": "Bearer fake-client-only",
          },
        });
        expect(response.status).toBe(200);
        expect(up.paths.at(-1)).toBe(`${mount}${original}`);
        expect(up.seen.at(-1)?.authorization).toBe(`Bearer ${REAL_KEY}`);
        expect(up.seen.at(-1)?.["x-api-key"]).toBe(REAL_KEY);
        expect(up.seen.at(-1)?.["proxy-authorization"]).toBeUndefined();
        expect(JSON.stringify(up.seen.at(-1))).not.toContain(grant.token);
      }
      const before = up.paths.length;
      for (const path of [
        "/v0/management/keys",
        "/v1/v1/responses",
        "/v1/../responses",
        "/hermes/v1/responses",
      ]) {
        expect(
          (await request(socket, { method: "POST", path, headers: { "x-api-key": grant.token } }))
            .status,
        ).toBe(403);
      }
      expect(
        (
          await request(socket, {
            method: "POST",
            path: "/v1/responses",
            headers: { "x-api-key": "fake-invalid-token" },
          })
        ).status,
      ).toBe(401);
      expect(up.paths).toHaveLength(before);
      await grant.close();
    }
    expect(up.paths).toHaveLength(bases.length * 3);
  });

  test("upstream redirects are rejected without contacting the redirect destination", async () => {
    const destination = await upstream();
    const up = await upstream(`${destination.url}/v1/responses`);
    const grant = await (await broker(`${up.url}/v1/`)).grant({
      runId: "redirect-fixture",
      network: "gateway",
    });
    const response = await request(join(grant.socketDir ?? "", "llm.sock"), {
      method: "POST",
      path: "/v1/responses",
      headers: { "x-api-key": grant.token },
    });
    expect(response.status).toBe(502);
    expect(response.body).toBe("gateway redirects are not allowed");
    expect(up.paths).toEqual(["/v1/responses"]);
    expect(destination.paths).toEqual([]);
    expect(destination.seen).toEqual([]);
  });

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

test.each([
  "ftp://fixture.invalid",
  "http://fixture.invalid/v2",
  "http://fixture.invalid/v1/v1",
  "http://fixture.invalid/v1/proxy",
  "http://fixture.invalid/proxy//mount",
  "http://fixture.invalid/proxy/../mount",
  "http://fixture.invalid/proxy/./mount",
  "http://fixture.invalid/proxy%2Fmount",
  "http://fixture.invalid/proxy\\mount",
  "http://fixture.invalid/v1?redirect=fixture",
  "http://fixture.invalid/v1#fragment",
])("rejects unsupported gateway base %s without opening sockets", (gatewayUrl) => {
  expect(() => new CredentialBroker({ gatewayUrl, gatewayKey: { value: REAL_KEY } })).toThrow(
    "unsupported gateway base",
  );
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
