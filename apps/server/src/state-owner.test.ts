import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createServer } from "./http/app.js";
import { MemoryCore } from "./memory-core.js";

test("second owner fails before loading auth; revoked keys stay revoked across actual reopen", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "matrix-owner-revoke-"));
  const first = createServer({ core: new MemoryCore(), stateDir });
  const { token, key } = first.keys.create({
    name: "revocation-fixture",
    scope: { projects: "*", actions: ["admin"] },
  });
  first.keys.revoke(key.id);
  const snapshot = readFileSync(join(stateDir, "keys.json"), "utf8");
  expect(() => createServer({ core: new MemoryCore(), stateDir })).toThrow("ownership unavailable");
  expect(statSync(join(stateDir, ".state-owner.lock")).mode & 0o777).toBe(0o600);
  await first.close();
  const restarted = createServer({ core: new MemoryCore(), stateDir });
  try {
    expect(restarted.keys.verify(token)).toBeNull();
    expect(() =>
      first.keys.create({ name: "stale-owner", scope: { projects: "*", actions: ["admin"] } }),
    ).toThrow("ownership lost");
    expect(readFileSync(join(stateDir, "keys.json"), "utf8")).toBe(snapshot);
    restarted.keys.create({ name: "new-owner", scope: { projects: "*", actions: ["read"] } });
  } finally {
    await restarted.close();
  }
  const again = createServer({ core: new MemoryCore(), stateDir });
  try {
    expect(
      (await again.app.request("/v1/projects", { headers: { authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(401);
  } finally {
    await again.close();
  }
});

test("kernel lifetime lock excludes another process and releases after SIGKILL without deleting lockfiles", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "matrix-owner-crash-"));
  const module = fileURLToPath(new URL("./http/app.ts", import.meta.url));
  const coreModule = fileURLToPath(new URL("./memory-core.ts", import.meta.url));
  const program = `import { createServer } from ${JSON.stringify(module)}; import { MemoryCore } from ${JSON.stringify(coreModule)}; const server = createServer({core: new MemoryCore(), stateDir: ${JSON.stringify(stateDir)}}); const {token, key} = server.keys.create({name: "crash-fixture", scope: {projects: "*", actions: ["admin"]}}); server.keys.revoke(key.id); console.log(JSON.stringify({token})); setInterval(() => {}, 1000);`;
  const child = spawn("bun", ["-e", program], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const token = await new Promise<string>((resolveReady, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("ownership fixture exited before readiness")));
      child.stdout.on("data", (data: Buffer) => {
        resolveReady((JSON.parse(data.toString()) as { token: string }).token);
      });
    });
    expect(() => createServer({ core: new MemoryCore(), stateDir })).toThrow(
      "ownership unavailable",
    );
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    child.kill("SIGKILL");
    await exited;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const reopened = createServer({ core: new MemoryCore(), stateDir });
    try {
      expect(
        (
          await reopened.app.request("/v1/projects", {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(401);
    } finally {
      await reopened.close();
    }
  } finally {
    child.kill("SIGKILL");
  }
}, 15_000);

test("failed store loading releases ownership without resetting corrupt private state", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "matrix-owner-rollback-"));
  const file = join(stateDir, "keys.json");
  writeFileSync(file, "invalid JSON", { mode: 0o600 });
  expect(() => createServer({ core: new MemoryCore(), stateDir })).toThrow();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  const { PrivateStateOwner } = await import("./state-owner.js");
  const owner = new PrivateStateOwner(stateDir);
  try {
    expect(readFileSync(file, "utf8")).toBe("invalid JSON");
  } finally {
    await owner.close();
  }
});

test("close retains ownership until pending requests drain and rejects new requests", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "matrix-owner-drain-"));
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolveStarted) => {
    started = resolveStarted;
  });
  const pending = new Promise<void>((resolveFinish) => {
    finish = resolveFinish;
  });
  const server = createServer({
    core: new MemoryCore(),
    stateDir,
    health: async () => {
      started();
      await pending;
      return {};
    },
  });
  const request = server.app.request("/healthz");
  await entered;
  const closed = server.close();
  expect(server.close()).toBe(closed);
  expect(() => createServer({ core: new MemoryCore(), stateDir })).toThrow("ownership unavailable");
  expect((await server.app.request("/healthz")).status).toBe(503);
  finish();
  expect((await request).status).toBe(200);
  await closed;
  const reopened = createServer({ core: new MemoryCore(), stateDir });
  await reopened.close();
});
