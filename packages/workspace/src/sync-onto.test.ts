import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { WorktreeGitPort } from "./git-port.js";
import { NativeWorkspace } from "./native.js";

/** A repo with one file, a run worktree on `matrix/sync`, and helpers to commit on each side. */
async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "matrix-sync-test-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@localhost", ...args], {
      encoding: "utf8",
    }).trim();
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "b.txt"), "b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const workspace = new NativeWorkspace({ root: await mkdtemp(join(tmpdir(), "matrix-sync-wt-")) });
  const { workdir } = await workspace.prepare({
    projectId: "p",
    ticketId: "t",
    repoPath: repo,
    baseBranch: "main",
    branch: "matrix/sync",
  });
  const port = new WorktreeGitPort({ trusted: workspace.trusted });
  const commit = async (cwd: string, file: string, body: string, message: string) => {
    await writeFile(join(cwd, file), body);
    git(cwd, "add", file);
    git(cwd, "commit", "-qm", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  return { repo, workdir, port, git, commit, trusted: workspace.trusted };
}

describe("syncOnto (rebase before an auto-merge)", { timeout: 60_000 }, () => {
  test("already on the base tip: current, nothing moves", async () => {
    const f = await fixture();
    await f.commit(f.workdir, "b.txt", "ticket\n", "ticket");
    const base = f.git(f.repo, "rev-parse", "main");
    expect(await f.port.syncOnto(f.workdir, base)).toEqual({ kind: "current" });
  });

  test("a clean rebase keeps the ticket commit on the new base and moves the trusted BASE", async () => {
    const f = await fixture();
    await f.commit(f.workdir, "b.txt", "ticket\n", "ticket");
    const tip = await f.commit(f.repo, "a.txt", "one\ntwo\nthree\nfour\n", "main moved");
    const result = await f.port.syncOnto(f.workdir, tip);
    expect(result.kind).toBe("rebased");
    if (result.kind !== "rebased") return;
    expect(f.git(f.workdir, "rev-parse", "HEAD^")).toBe(tip);
    expect(f.git(f.workdir, "log", "-1", "--format=%s")).toBe("ticket");
    expect(await readFile(join(f.workdir, "b.txt"), "utf8")).toBe("ticket\n");
    expect((await f.trusted.lookup(f.workdir)).baseSha).toBe(tip);
    expect(await f.port.isClean(f.workdir)).toBe(true);
  });

  test("a conflict re-applies the change on the base with markers left uncommitted", async () => {
    const f = await fixture();
    await f.commit(f.workdir, "a.txt", "one\nTICKET\nthree\n", "ticket");
    await f.commit(f.workdir, "b.txt", "ticket b\n", "ticket b");
    const tip = await f.commit(f.repo, "a.txt", "one\nMAIN\nthree\n", "main moved");
    const result = await f.port.syncOnto(f.workdir, tip);
    expect(result).toEqual({ kind: "conflict", files: ["a.txt"] });
    expect(f.git(f.workdir, "rev-parse", "HEAD")).toBe(tip);
    const a = await readFile(join(f.workdir, "a.txt"), "utf8");
    expect(a).toContain("<<<<<<<");
    expect(a).toContain("MAIN");
    expect(a).toContain("TICKET");
    expect(await readFile(join(f.workdir, "b.txt"), "utf8")).toBe("ticket b\n");
    // No unmerged index entries: the implementer edits files and the commit gate commits them.
    expect(f.git(f.workdir, "diff", "--name-only", "--diff-filter=U")).toBe("");
    expect((await f.trusted.lookup(f.workdir)).baseSha).toBe(tip);
  });

  test("refuses a dirty worktree", async () => {
    const f = await fixture();
    const tip = await f.commit(f.repo, "a.txt", "x\n", "main moved");
    await writeFile(join(f.workdir, "b.txt"), "dirty\n");
    await expect(f.port.syncOnto(f.workdir, tip)).rejects.toThrow(/uncommitted/);
  });
});
