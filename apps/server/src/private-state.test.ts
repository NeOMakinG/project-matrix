import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { hashToken, KeyStore } from "./auth/keys.js";
import { BudgetTracker } from "./auth/limits.js";
import { SessionStore } from "./auth/sessions.js";
import { PrivateState } from "./private-state.js";
import { PrivateStateOwner } from "./state-owner.js";

const directory = () => mkdtempSync(join(tmpdir(), "matrix-private-state-"));

describe("private restart state", () => {
  test("writes atomically with mode 600 and fails closed on corrupt or permissive files", () => {
    const file = join(directory(), "state.json");
    const state = new PrivateState<{ value: number }>(file);
    expect(state.load({ value: 0 })).toEqual({ value: 0 });
    state.save({ value: 1 });
    state.save({ value: 2 });
    expect(new PrivateState(file).load(null)).toEqual({ value: 2 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o644);
    expect(() => state.load({ value: 0 })).toThrow("mode 600");
    chmodSync(file, 0o600);
    writeFileSync(file, "invalid JSON");
    expect(() => state.load({ value: 0 })).toThrow();
  });

  test("refuses symlinks to the file and parent", () => {
    const root = directory();
    const target = join(root, "target.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    const link = join(root, "link.json");
    symlinkSync(target, link);
    expect(() => new PrivateState(link).load(null)).toThrow();
    const parent = join(root, "parent");
    symlinkSync(directory(), parent);
    expect(() => new PrivateState(join(parent, "state.json")).save({})).toThrow();
    expect(readFileSync(target, "utf8")).toBe("{}");
  });

  test("persists scoped hashed keys, revocation and budgets without storing raw API tokens", async () => {
    const root = directory();
    const file = join(root, "keys.json");
    const owner = new PrivateStateOwner(root);
    const keys = new KeyStore(file, owner);
    const { token, key } = keys.create({
      name: "human",
      kind: "human",
      scope: { projects: ["pilot"], actions: ["read"] },
      budget: { mutationsPerDay: 1 },
    });
    expect(readFileSync(file, "utf8")).not.toContain(token.split("_").slice(2).join("_"));
    expect(keys.verify(token)?.scope.projects).toEqual(["pilot"]);
    expect(() => new KeyStore(file, owner)).toThrow("already loaded");
    keys.revoke(key.id);
    const hashed = hashToken(token);
    expect(hashed).not.toBeNull();
    const imported = { ...keys.get(key.id)!, ...hashed! };
    delete imported.revokedAt;
    await owner.close();
    const restartedOwner = new PrivateStateOwner(root);
    const restarted = new KeyStore(file, restartedOwner);
    restarted.importHashed(imported);
    expect(restarted.verify(token)).toBeNull();
    await restartedOwner.close();
    const usage = join(root, "usage.json");
    const clock = () => Date.UTC(2026, 9, 12);
    expect(
      new BudgetTracker(clock, usage).consume(key.id, { mutationsPerDay: 1 }, "mutations"),
    ).toBe(true);
    expect(
      new BudgetTracker(clock, usage).consume(key.id, { mutationsPerDay: 1 }, "mutations"),
    ).toBe(false);
  });

  test("persists sessions, CSRF and logout; expired sessions stay invalid", () => {
    const file = join(directory(), "sessions.json");
    let now = Date.UTC(2026, 9, 12);
    const sessions = new SessionStore(() => now, file);
    const session = sessions.create("human");
    const restarted = new SessionStore(() => now, file);
    expect(restarted.get(session.id)).toEqual(session);
    restarted.deleteForKey("human");
    expect(new SessionStore(() => now, file).get(session.id)).toBeNull();
    const expired = restarted.create("human");
    now = expired.expiresAt;
    expect(new SessionStore(() => now, file).get(expired.id)).toBeNull();
  });
});
