import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhaseContext, Sandbox, SandboxExecSpec } from "@matrix/core";
import { describe, expect, test } from "vitest";
import { baselineChecks } from "./baseline-checks.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "matrix-baseline-"));
  const path = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git(path, "config", "user.email", "t@t");
  git(path, "config", "user.name", "t");
  writeFileSync(join(path, "package-lock.json"), "{}");
  git(path, "add", ".");
  git(path, "commit", "-qm", "base");
  const base = git(path, "rev-parse", "HEAD");
  const wt = join(dir, "run");
  git(path, "worktree", "add", "-q", "-b", "feat", wt, "main");
  writeFileSync(join(wt, "x.ts"), "bug");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "agent work");
  return { dir, path, wt, base };
}

function harness(r: ReturnType<typeof repo>, external = true) {
  const execs: SandboxExecSpec[] = [];
  const sandbox: Sandbox = {
    kind: "bwrap",
    exec: async (spec) => {
      execs.push(spec);
      return {
        code: 2,
        stdout: `${spec.workdir}/src/a.ts(1,1): error TS2304: Cannot find name 'old'.`,
        stderr: "",
      };
    },
  };
  const port = baselineChecks({
    sandbox,
    root: join(r.dir, "state"),
    headSha: async (w) => git(w, "rev-parse", "HEAD"),
    compareByDefault: () => external,
  });
  const ctx = {
    project: { id: "tj", repoPath: r.path, baseBranch: "main", runTimeoutMs: 600_000 },
    workdir: r.wt,
    signal: new AbortController().signal,
    emit: () => undefined,
  } as unknown as PhaseContext;
  return { port, ctx, execs };
}

describe("baselineChecks port", () => {
  test("runs on the merge-base in a throwaway worktree, once per base SHA", async () => {
    const r = repo();
    const { port, ctx, execs } = harness(r);
    const check = { kind: "typecheck" as const, cmd: ["tsc", "--noEmit"] };
    const first = await port.run(ctx, [check]);
    expect(first.baseSha).toBe(r.base);
    expect(first.results).toEqual([
      { code: 2, failures: ["src/a.ts: TS2304: Cannot find name 'old'."] },
    ]);
    expect(execs).toHaveLength(1);
    expect(execs[0]?.workdir).not.toBe(r.wt);
    expect(execs[0]?.network).toBe("none");
    // Worktree removed, result cached host-side: a second run never executes again.
    expect(existsSync(execs[0]?.workdir as string)).toBe(false);
    expect(await port.run(ctx, [check])).toEqual(first);
    expect(execs).toHaveLength(1);
    expect(readdirSync(join(r.dir, "state", "cache", "tj"))).toHaveLength(1);
  });

  test("agent commits never become the base, even after merging the base forward", async () => {
    const r = repo();
    writeFileSync(join(r.path, "y.ts"), "later");
    git(r.path, "add", ".");
    git(r.path, "commit", "-qm", "main moves");
    const tip = git(r.path, "rev-parse", "HEAD");
    git(r.wt, "merge", "-q", "--no-edit", "main");
    const { port, ctx } = harness(r);
    const { baseSha } = await port.run(ctx, [{ kind: "lint", cmd: ["eslint", "."] }]);
    expect(baseSha).toBe(tip);
    expect(git(r.path, "merge-base", "--is-ancestor", baseSha, "main")).toBe("");
  });

  test("default mode follows the project kind; concurrent runs share one base execution", async () => {
    const r = repo();
    expect(harness(r, false).port.defaultMode({} as PhaseContext)).toBe("strict");
    const { port, ctx, execs } = harness(r);
    expect(port.defaultMode(ctx)).toBe("compare");
    const check = { kind: "test" as const, cmd: ["npm", "test"], parser: "tsc" as const };
    await Promise.all([port.run(ctx, [check]), port.run(ctx, [check])]);
    expect(execs).toHaveLength(1);
  });

  test("a base run that cannot run is no baseline and is not cached", async () => {
    const r = repo();
    const { ctx } = harness(r);
    let n = 0;
    const port = baselineChecks({
      sandbox: {
        kind: "bwrap",
        exec: async () => (n++, { code: 127, stdout: "", stderr: "sh: tsc: not found" }),
      },
      root: join(r.dir, "state2"),
      headSha: async (w) => git(w, "rev-parse", "HEAD"),
      compareByDefault: () => true,
    });
    const check = { kind: "typecheck" as const, cmd: ["tsc"] };
    expect((await port.run(ctx, [check])).results[0]).toHaveProperty("error");
    await port.run(ctx, [check]);
    expect(n).toBe(2);
  });
  test("a base ref moved onto the run HEAD is refused (agent work never becomes the base)", async () => {
    const r = repo();
    git(r.path, "update-ref", "refs/heads/main", git(r.wt, "rev-parse", "HEAD"));
    const { port, ctx, execs } = harness(r);
    await expect(port.run(ctx, [{ kind: "lint", cmd: ["eslint", "."] }])).rejects.toThrow(
      /run HEAD/,
    );
    expect(execs).toHaveLength(0);
  });
});
