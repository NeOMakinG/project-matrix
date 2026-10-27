import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { REPO_ROOT } from "./local-qa-agent.js";

// The shared simulator lock protocol, exercised on the real scripts with a temp lock dir and a
// stubbed tapflow state (no relay in CI).
const UDID = "241CA4C0-C8CE-4904-A61B-67E81E09B621";
const LANE = join(REPO_ROOT, "ops", "qa-lane", "ios-qa.sh");
const SIMLOCK = join(REPO_ROOT, "ops", "qa-lane", "sim-lock.sh");

function env(state: string) {
  const dir = mkdtempSync(join(tmpdir(), "simlock-"));
  const stateFile = join(dir, "state");
  writeFileSync(stateFile, `${state}\n`);
  return {
    dir,
    locks: join(dir, "locks"),
    stateFile,
    vars: {
      ...process.env,
      MATRIX_SIM_LOCK_DIR: join(dir, "locks"),
      MATRIX_QA_TAPFLOW_STATE_FILE: stateFile,
      MATRIX_QA_NODE_BIN: dirname(process.execPath),
      MATRIX_QA_ROOT: join(dir, "root"),
    },
  };
}

const run = (script: string, args: string[], vars: NodeJS.ProcessEnv) =>
  spawnSync("bash", [script, ...args], { env: vars, encoding: "utf8", timeout: 20_000 });

test("lane lock: acquire, beat, release; a second tenant waits and times out with 12", () => {
  const e = env("free");
  const a = run(LANE, ["lock", "mx-job-aaaa1111", "0", "holder-a", UDID], e.vars);
  expect(a.status).toBe(0);
  expect(readFileSync(join(e.locks, `${UDID}.lock`, "tenant"), "utf8").trim()).toBe("matrix-qa");
  // Another tenant (sim-lock) sees it held.
  const b = run(SIMLOCK, ["acquire", UDID, "other-agent", "0"], e.vars);
  expect(b.status).toBe(12);
  expect(b.stderr).toMatch(/holder-a/);
  expect(run(LANE, ["beat", "mx-job-aaaa1111"], e.vars).status).toBe(0);
  expect(run(LANE, ["beat", "mx-job-bbbb2222"], e.vars).status).toBe(12);
  expect(run(LANE, ["unlock", "mx-job-bbbb2222"], e.vars).status).toBe(0);
  expect(existsSync(join(e.locks, `${UDID}.lock`))).toBe(true);
  expect(run(LANE, ["unlock", "mx-job-aaaa1111"], e.vars).status).toBe(0);
  expect(existsSync(join(e.locks, `${UDID}.lock`))).toBe(false);
});

test("a live tapflow session blocks the lane (12) and sim-lock", () => {
  const e = env("busy");
  const a = run(LANE, ["lock", "mx-job-aaaa1111", "0", "holder-a", UDID], e.vars);
  expect(a.status).toBe(12);
  expect(a.stderr).toMatch(/tapflow session/);
  expect(existsSync(join(e.locks, `${UDID}.lock`))).toBe(false);
  expect(run(SIMLOCK, ["acquire", UDID, "x", "0"], e.vars).status).toBe(12);
});

test("an unreachable relay stops the lane (11)", () => {
  const e = env("error");
  expect(run(LANE, ["lock", "mx-job-aaaa1111", "0", "h", UDID], e.vars).status).toBe(11);
});

test("a stale lock (no beat for 20 min) is reclaimed; sim-lock release needs the token", () => {
  const e = env("free");
  const l = join(e.locks, `${UDID}.lock`);
  mkdirSync(l, { recursive: true });
  writeFileSync(join(l, "owner"), "dead");
  writeFileSync(join(l, "holder"), "crashed");
  writeFileSync(join(l, "beat"), String(Math.floor(Date.now() / 1000) - 1300));
  const t = run(SIMLOCK, ["acquire", UDID, "agent-b", "0"], e.vars);
  expect(t.status).toBe(0);
  expect(t.stderr).toMatch(/reclaimed a stale simulator lock \(holder crashed\)/);
  const token = t.stdout.trim();
  expect(run(LANE, ["lock", "mx-job-aaaa1111", "0", "h", UDID], e.vars).status).toBe(12);
  run(SIMLOCK, ["release", UDID, "wrong"], e.vars);
  expect(existsSync(l)).toBe(true);
  expect(run(SIMLOCK, ["release", UDID, token], e.vars).status).toBe(0);
  expect(existsSync(l)).toBe(false);
});

test("reclaim drops only this holder's lock", () => {
  const e = env("free");
  expect(run(LANE, ["lock", "mx-job-aaaa1111", "0", "holder-a", UDID], e.vars).status).toBe(0);
  run(LANE, ["reclaim", "holder-b"], e.vars);
  expect(existsSync(join(e.locks, `${UDID}.lock`))).toBe(true);
  const r = run(LANE, ["reclaim", "holder-a"], e.vars);
  expect(r.stdout).toMatch(/reclaimed/);
  expect(existsSync(join(e.locks, `${UDID}.lock`))).toBe(false);
});

test("sim-lock fails closed when the relay cannot be asked; lane steps need the lock", () => {
  const e = env("error");
  expect(run(SIMLOCK, ["acquire", UDID, "x", "0"], e.vars).status).toBe(11);
  expect(existsSync(join(e.locks, `${UDID}.lock`))).toBe(false);
  const f = env("free");
  const i = run(LANE, ["install", "mx-job-aaaa1111", UDID, "a/*.app", "com.wayline.app"], f.vars);
  expect(i.status).toBe(12);
  expect(i.stderr).toMatch(/no longer holds its lock/);
});

test("sim-lock run holds the lock for the command and releases it", () => {
  const e = env("free");
  const lockDir = join(e.locks, `${UDID}.lock`);
  const r = run(SIMLOCK, ["run", UDID, "agent-c", "0", "--", "test", "-d", lockDir], e.vars);
  expect(r.status).toBe(0);
  expect(existsSync(lockDir)).toBe(false);
});
