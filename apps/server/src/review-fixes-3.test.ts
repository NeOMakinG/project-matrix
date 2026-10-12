import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createServer } from "./http/app.js";
import { MemoryCore } from "./memory-core.js";
import { nowTs, orcaHeaders, SECRETS, setup } from "./test-helpers.js";
import { hmacHex } from "./webhooks.js";

const sentry = (body: string, ts = nowTs()) => ({
  "content-type": "application/json",
  "sentry-hook-signature": hmacHex(SECRETS.sentry ?? "", body),
  "sentry-hook-timestamp": ts,
});

describe("round 3: webhook replay", () => {
  test("Sentry deliveries without a timestamp are refused", async () => {
    const ctx = await setup();
    const body = JSON.stringify({ data: { issue: { id: "1", title: "no ts" } } });
    const response = await ctx.server.app.request("/hooks/sentry", {
      method: "POST",
      body,
      headers: { "sentry-hook-signature": hmacHex(SECRETS.sentry ?? "", body) },
    });
    expect(response.status).toBe(401);
    expect(ctx.core.signals).toHaveLength(0);
  });

  test("replay protection survives a restart (persisted, hashes only)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-replay-"));
    const file = join(dir, "replay.log");
    const body = JSON.stringify({ data: { issue: { id: "2", title: "restart" } } });
    const headers = sentry(body);

    const first = createServer({ core: new MemoryCore(), secrets: SECRETS, replayLogFile: file });
    expect(
      (await first.app.request("/hooks/sentry", { method: "POST", body, headers })).status,
    ).toBe(202);

    const restartedCore = new MemoryCore();
    const restarted = createServer({ core: restartedCore, secrets: SECRETS, replayLogFile: file });
    const replay = await restarted.app.request("/hooks/sentry", { method: "POST", body, headers });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ duplicate: true });
    expect(restartedCore.signals).toHaveLength(0);

    const stored = readFileSync(file, "utf8");
    expect(stored).not.toContain("restart");
    expect(stored.trim()).toMatch(/^[0-9a-f]{64} \d+$/);
  });
});

describe("round 3: signed Orca hook", () => {
  const post = (
    ctx: Awaited<ReturnType<typeof setup>>,
    body: string,
    headers: Record<string, string>,
  ) => ctx.server.app.request("/hooks/orca", { method: "POST", body, headers });
  const status = (worktree: string, value: string) =>
    JSON.stringify({ worktree, agent: "claude-code", status: value });

  test("bad signature, missing or stale timestamp, and the old bearer secret are refused", async () => {
    const ctx = await setup();
    const body = status("wt/a", "working");
    const good = orcaHeaders(body, SECRETS.orca ?? "");
    expect((await post(ctx, body, { ...good, "x-orca-signature": "sha256=00" })).status).toBe(401);
    expect((await post(ctx, body, { ...good, "x-orca-timestamp": "" })).status).toBe(401);
    const stale = orcaHeaders(body, SECRETS.orca ?? "", { at: Date.now() - 10 * 60 * 1000 });
    expect((await post(ctx, body, stale)).status).toBe(401);
    expect(
      (
        await post(ctx, body, {
          "content-type": "application/json",
          authorization: `Bearer ${SECRETS.orca}`,
        })
      ).status,
    ).toBe(401);
    expect(ctx.core.orca).toHaveLength(0);
  });

  test("a nonce is single-use", async () => {
    const ctx = await setup();
    const body = status("wt/b", "working");
    const headers = orcaHeaders(body, SECRETS.orca ?? "", { nonce: "nonce-aaaaaaaaaaaaaaaa" });
    expect((await post(ctx, body, headers)).status).toBe(202);
    expect(await (await post(ctx, body, headers)).json()).toEqual({ duplicate: true });
    expect(ctx.core.orca).toHaveLength(1);
  });

  test("older or replayed statuses can't move a worktree; terminal statuses stick", async () => {
    const ctx = await setup();
    const now = Date.now();
    const send = (value: string, at: number) =>
      post(
        ctx,
        status("wt/c", value),
        orcaHeaders(status("wt/c", value), SECRETS.orca ?? "", { at }),
      );

    expect((await send("working", now - 60_000)).status).toBe(202);
    expect((await send("done", now - 30_000)).status).toBe(202);
    // An older "working" (sent before "done") arrives late: ignored.
    expect(await (await send("working", now - 45_000)).json()).toEqual({ ignored: "out_of_order" });
    // A newer non-terminal status can't reopen a finished worktree.
    expect(await (await send("working", now)).json()).toEqual({ ignored: "terminal" });
    expect(ctx.core.orca.map((s) => s.status)).toEqual(["working", "done"]);
  });
});

describe("round 3: settings preconditions", () => {
  test("settings writes without If-Match get 428", async () => {
    const ctx = await setup();
    const response = await ctx.call(ctx.admin, "PATCH", "/v1/settings", { note: "x" });
    expect(response.status).toBe(428);
    expect(await ctx.json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "precondition_required" },
    });
  });
});
