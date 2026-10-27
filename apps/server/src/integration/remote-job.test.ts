import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { remoteJobArgv, splitReport } from "./remote-job.js";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "mx-rj-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { dir, sha: git("rev-parse", "HEAD") };
}
const run = (argv: string[], cwd: string, env: Record<string, string> = {}) =>
  spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8", env: { ...process.env, ...env } });

describe("remote job script", () => {
  test("isolated env, stdin from file, placeholder filled from the host key file", () => {
    const { dir, sha } = repo();
    const keyFile = join(dir, "..", `${sha.slice(0, 6)}.env`);
    writeFileSync(keyFile, "GW_KEY=real-key\n");
    const argv = remoteJobArgv({
      sha,
      setup: [["sh", "-c", "echo setup >&2"]],
      argv: ["sh", "-c", 'cat; echo "$API|$OTHER|${HOSTONLY:-unset}|$HOME"'],
      env: { API: "__PH__", OTHER: "x'y" },
      stdin: "prompt text\n",
      placeholder: "__PH__",
      key: { envFile: keyFile, name: "GW_KEY" },
    });
    expect(argv[2]).not.toContain("real-key");
    expect(argv[2]).not.toContain("prompt text");
    const r = run(argv, dir, { HOSTONLY: "leak" });
    expect(r.status).toBe(0);
    const [prompt, line] = r.stdout.trim().split("\n");
    expect(prompt).toBe("prompt text");
    expect(line).toMatch(/^real-key\|x'y\|unset\|\/.+\/home$/);
    expect(r.stderr).toContain("setup");
  });

  test("wrong checkout, failed setup and exit codes", () => {
    const { dir, sha } = repo();
    expect(
      run(remoteJobArgv({ sha: "f".repeat(40), setup: [], argv: ["true"], env: {} }), dir).status,
    ).toBe(96);
    expect(
      run(remoteJobArgv({ sha, setup: [["false"]], argv: ["true"], env: {} }), dir).status,
    ).toBe(95);
    expect(
      run(remoteJobArgv({ sha, setup: [], argv: ["sh", "-c", "exit 7"], env: {} }), dir).status,
    ).toBe(7);
  });

  test("implement: changes are committed and pushed to the scratch branch", () => {
    const { dir, sha } = repo();
    const bare = mkdtempSync(join(tmpdir(), "mx-rj-bare-"));
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", bare]);
    const argv = remoteJobArgv({
      sha,
      setup: [],
      argv: ["sh", "-c", "echo b > b.txt"],
      env: {},
      pushTo: "matrix-run/r1-out",
    });
    expect(run(argv, dir).status).toBe(0);
    const files = execFileSync(
      "git",
      ["-C", bare, "show", "--name-only", "--format=", "matrix-run/r1-out"],
      { encoding: "utf8" },
    );
    expect(files.trim()).toBe("b.txt");
  });

  test("report rides on stdout and is split back off", () => {
    const { dir, sha } = repo();
    const argv = remoteJobArgv({
      sha,
      setup: [],
      argv: ["sh", "-c", "echo out; echo '{\"ok\":1}' > rep.json"],
      env: {},
      report: "rep.json",
    });
    const r = run(argv, dir);
    expect(splitReport(r.stdout)).toEqual({ stdout: "out\n", report: '{"ok":1}\n' });
    expect(readFileSync(join(dir, "rep.json"), "utf8")).toContain("ok");
  });

  test("refuses bad input before building anything", () => {
    const base = { sha: "a".repeat(40), setup: [], argv: ["x"], env: {} };
    expect(() => remoteJobArgv({ ...base, sha: "abc" })).toThrow("full commit sha");
    expect(() => remoteJobArgv({ ...base, pushTo: "main" })).toThrow("scratch branch");
    expect(() => remoteJobArgv({ ...base, env: { "A B": "1" } })).toThrow("invalid env name");
    expect(() => remoteJobArgv({ ...base, env: { K: "P" }, placeholder: "P" })).toThrow(
      "key source",
    );
    expect(() => remoteJobArgv({ ...base, stdin: "x".repeat(210_000) })).toThrow("200KB");
  });
});
