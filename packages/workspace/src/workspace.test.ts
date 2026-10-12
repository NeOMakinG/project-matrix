import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LineExecutor } from "@matrix/sandbox";
import { describe, expect, test } from "vitest";
import { WorktreeGitPort } from "./git-port";
import { NativeWorkspace } from "./native";
import { checkOrcaContract, OrcaWorkspace } from "./orca";

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "matrix-ws-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });
  git("init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), "x");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

describe("native workspace", () => {
  test("creates, reuses and removes a worktree per ticket", async () => {
    const repoPath = await repo();
    const root = await mkdtemp(join(tmpdir(), "matrix-ws-root-"));
    const ws = new NativeWorkspace({ root });
    const target = {
      projectId: "p/1",
      ticketId: "MX-1",
      repoPath,
      branch: "matrix/mx-1",
      baseBranch: "main",
    };
    const prepared = await ws.prepare(target);
    expect(prepared.workdir).toBe(join(root, "p-1", "MX-1"));
    expect(existsSync(join(prepared.workdir, "README.md"))).toBe(true);
    expect((await ws.prepare(target)).workdir).toBe(prepared.workdir);
    await ws.cleanup(prepared);
    expect(existsSync(prepared.workdir)).toBe(false);
    expect(
      execFileSync("git", ["branch", "--list", "matrix/mx-1"], { cwd: repoPath }).toString(),
    ).toContain("matrix/mx-1");
    const again = await ws.prepare(target);
    expect(existsSync(again.workdir)).toBe(true);
  });

  test("never trusts a tampered .git pointer (no hostile config/hooks executed)", async () => {
    const repoPath = await repo();
    const root = await mkdtemp(join(tmpdir(), "matrix-ws-root-"));
    const ws = new NativeWorkspace({ root });
    const target = {
      projectId: "p",
      ticketId: "T",
      repoPath,
      branch: "matrix/t",
      baseBranch: "main",
    };
    const prepared = await ws.prepare(target);
    const evil = await mkdtemp(join(tmpdir(), "matrix-evil-"));
    const pwned = join(evil, "pwned");
    execFileSync("git", ["init", "-q", "--bare", join(evil, "g")]);
    await writeFile(
      join(evil, "g", "config"),
      `[core]\n\tbare = false\n\tfsmonitor = "touch ${pwned}"\n\thooksPath = ${evil}\n`,
    );
    await writeFile(join(prepared.workdir, ".git"), `gitdir: ${join(evil, "g")}\n`);
    // A tampered worktree is reclaimed without ever running git against the hostile gitdir.
    const again = await ws.prepare(target);
    expect(existsSync(join(again.workdir, "README.md"))).toBe(true);
    expect(existsSync(pwned)).toBe(false);
    await writeFile(join(again.workdir, ".git"), `gitdir: ${join(evil, "g")}\n`);
    await ws.cleanup(again);
    expect(existsSync(pwned)).toBe(false);
    expect(existsSync(prepared.workdir)).toBe(false);
  });

  test("rejects invalid branch names", async () => {
    const ws = new NativeWorkspace({ root: await mkdtemp(join(tmpdir(), "matrix-ws-")) });
    await expect(
      ws.prepare({
        projectId: "p",
        ticketId: "t",
        repoPath: await repo(),
        branch: "bad..name",
        baseBranch: "main",
      }),
    ).rejects.toThrow();
  });
});

const goodContext = {
  schemaVersion: 1,
  commands: [
    {
      command: "worktree create",
      flags: ["repo", "name", "base-branch", "json", "agent", "prompt", "issue"],
    },
    { command: "worktree rm", flags: ["worktree", "force", "json"] },
    { command: "repo list", flags: ["json"] },
  ],
};

describe("orca workspace", () => {
  test("contract check reports missing commands and flags", () => {
    expect(checkOrcaContract(goodContext)).toEqual([]);
    expect(checkOrcaContract({ schemaVersion: 2, commands: [] })).toEqual(
      expect.arrayContaining(["unsupported schemaVersion 2", "missing command: orca worktree rm"]),
    );
  });

  test.runIf(
    (() => {
      try {
        execFileSync("orca", ["agent-context", "--json"], { stdio: "ignore", timeout: 15_000 });
        return true;
      } catch {
        return false;
      }
    })(),
  )("installed Orca satisfies the contract (read-only)", () => {
    const context = JSON.parse(execFileSync("orca", ["agent-context", "--json"]).toString());
    expect(checkOrcaContract(context)).toEqual([]);
  });

  test("prepare creates an Orca worktree for the registered repo, cleanup removes it", async () => {
    const repoPath = await realpath(await repo());
    const calls: string[][] = [];
    const executor: LineExecutor = async (spec, onLine) => {
      calls.push(spec.cmd);
      const args = spec.cmd.slice(1).join(" ");
      let result: unknown = {};
      if (args.startsWith("agent-context")) result = goodContext;
      else if (args.startsWith("repo list")) result = { repos: [{ id: "repo-1", path: repoPath }] };
      else if (args.startsWith("worktree create"))
        result = { worktree: { id: "wt-9", path: "/orca/wt-9" } };
      onLine(JSON.stringify(args.startsWith("agent-context") ? result : { ok: true, result }));
      return { exitCode: 0, timedOut: false, cancelled: false, stderrTail: "" };
    };
    const ws = new OrcaWorkspace({
      executor,
      agent: "claude",
      prompt: () => "build MX-1",
      issue: () => 42,
    });
    const prepared = await ws.prepare({
      projectId: "p",
      ticketId: "MX-1",
      repoPath,
      branch: "matrix/mx-1",
      baseBranch: "main",
    });
    expect(prepared).toEqual({ workdir: "/orca/wt-9", ref: "wt-9" });
    expect(calls[2]).toEqual([
      "orca",
      "worktree",
      "create",
      "--repo",
      "id:repo-1",
      "--name",
      "matrix-mx-1",
      "--base-branch",
      "main",
      "--json",
      "--agent",
      "claude",
      "--prompt",
      "build MX-1",
      "--issue",
      "42",
    ]);
    await ws.cleanup(prepared);
    expect(calls.at(-1)).toEqual([
      "orca",
      "worktree",
      "rm",
      "--worktree",
      "id:wt-9",
      "--force",
      "--json",
    ]);
  });

  test("unregistered repo is a clear error", async () => {
    const executor: LineExecutor = async (spec, onLine) => {
      const args = spec.cmd.slice(1).join(" ");
      onLine(
        JSON.stringify(
          args.startsWith("agent-context") ? goodContext : { ok: true, result: { repos: [] } },
        ),
      );
      return { exitCode: 0, timedOut: false, cancelled: false, stderrTail: "" };
    };
    await expect(
      new OrcaWorkspace({ executor }).prepare({
        projectId: "p",
        ticketId: "t",
        repoPath: await repo(),
        branch: "b",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/not registered in Orca/);
  });
});

describe("worktree git port", () => {
  test("reports exact HEAD, ignores gitignored files, tracks tree state", async () => {
    const repoPath = await repo();
    await writeFile(join(repoPath, ".gitignore"), "dist/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: repoPath });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "gi"], {
      cwd: repoPath,
    });
    const ws = new NativeWorkspace({ root: await mkdtemp(join(tmpdir(), "matrix-ws-")) });
    const { workdir } = await ws.prepare({
      projectId: "p",
      ticketId: "G",
      repoPath,
      branch: "matrix/g",
      baseBranch: "main",
    });
    const git = new WorktreeGitPort({ trusted: ws.trusted });
    expect(await git.headSha(workdir)).toBe(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath }).toString().trim(),
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workdir, "dist"));
    await writeFile(join(workdir, "dist", "bundle.js"), "x");
    expect(await git.isClean(workdir)).toBe(true);
    const before = await git.treeState(workdir);
    await writeFile(join(workdir, "new.ts"), "a");
    expect(await git.isClean(workdir)).toBe(false);
    const after = await git.treeState(workdir);
    expect(after).not.toBe(before);
    await writeFile(join(workdir, "new.ts"), "b");
    expect(await git.treeState(workdir)).not.toBe(after);
  });

  test("refuses a worktree whose .git was redirected", async () => {
    const repoPath = await repo();
    const ws = new NativeWorkspace({ root: await mkdtemp(join(tmpdir(), "matrix-ws-")) });
    const a = await ws.prepare({
      projectId: "p",
      ticketId: "A",
      repoPath,
      branch: "matrix/a",
      baseBranch: "main",
    });
    const b = await ws.prepare({
      projectId: "p",
      ticketId: "B",
      repoPath,
      branch: "matrix/b",
      baseBranch: "main",
    });
    const { readFile: rf } = await import("node:fs/promises");
    await writeFile(join(a.workdir, ".git"), await rf(join(b.workdir, ".git"), "utf8"));
    await expect(new WorktreeGitPort({ trusted: ws.trusted }).headSha(a.workdir)).rejects.toThrow(
      /points to|tampered|match/,
    );
  });
});

test("lease takeover: old runner stopped and worktree recreated, never reused", async () => {
  const repoPath = await repo();
  const stopped: string[] = [];
  const ws = new NativeWorkspace({
    root: await mkdtemp(join(tmpdir(), "matrix-ws-")),
    stopRunners: async (t) => {
      stopped.push(`${t.projectId}/${t.ticketId}`);
    },
  });
  const target = {
    projectId: "p",
    ticketId: "L",
    repoPath,
    branch: "matrix/l",
    baseBranch: "main",
  };
  const first = await ws.prepare(target);
  await writeFile(join(first.workdir, "half-written.ts"), "old owner");
  const second = await ws.prepare(target);
  expect(stopped).toEqual(["p/L"]);
  expect(second.workdir).toBe(first.workdir);
  expect(existsSync(join(second.workdir, "half-written.ts"))).toBe(false);
  expect(existsSync(join(second.workdir, "README.md"))).toBe(true);
});

describe("git port trusts only host-recorded gitdirs (round 2 PoC)", () => {
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd })
      .toString()
      .trim();

  test("a fake repo built inside the worktree can't forge HEAD or run its filters", async () => {
    const repoPath = await repo();
    const ws = new NativeWorkspace({ root: await mkdtemp(join(tmpdir(), "matrix-ws-")) });
    const { workdir } = await ws.prepare({
      projectId: "p",
      ticketId: "F",
      repoPath,
      branch: "matrix/f",
      baseBranch: "main",
    });
    const real = await new WorktreeGitPort({ trusted: ws.trusted }).headSha(workdir);
    const pwned = join(await mkdtemp(join(tmpdir(), "matrix-pwn-")), "pwned");
    const fake = join(workdir, ".fake");
    sh(workdir, "init", "-q", fake);
    await writeFile(join(fake, "x"), "forged");
    sh(fake, "add", "x");
    sh(fake, "commit", "-qm", "forged");
    const { mkdir: md } = await import("node:fs/promises");
    await md(join(fake, ".git", "worktrees", "w"), { recursive: true });
    await writeFile(join(fake, ".git", "worktrees", "w", "gitdir"), `${join(workdir, ".git")}\n`);
    await writeFile(
      join(fake, ".git", "worktrees", "w", "HEAD"),
      `${sh(fake, "rev-parse", "HEAD")}\n`,
    );
    await writeFile(join(fake, ".git", "worktrees", "w", "commondir"), "../..\n");
    await writeFile(
      join(fake, ".git", "config"),
      `[filter "evil"]\n\tclean = touch ${pwned}\n\tsmudge = touch ${pwned}\n`,
    );
    await writeFile(join(workdir, ".gitattributes"), "* filter=evil\n");
    await writeFile(join(workdir, ".git"), `gitdir: ${join(fake, ".git", "worktrees", "w")}\n`);
    const port = new WorktreeGitPort({ trusted: ws.trusted });
    await expect(port.headSha(workdir)).rejects.toThrow();
    await expect(port.isClean(workdir)).rejects.toThrow();
    expect(existsSync(pwned)).toBe(false);
    expect(real).toMatch(/^[0-9a-f]{40}$/);
  });

  test("filter drivers in the trusted config never run on worktree content", async () => {
    const repoPath = await repo();
    const pwned = join(await mkdtemp(join(tmpdir(), "matrix-pwn-")), "pwned");
    sh(repoPath, "config", "filter.evil.clean", `touch ${pwned}`);
    sh(repoPath, "config", "filter.evil.process", `touch ${pwned}`);
    const ws = new NativeWorkspace({ root: await mkdtemp(join(tmpdir(), "matrix-ws-")) });
    const { workdir } = await ws.prepare({
      projectId: "p",
      ticketId: "E",
      repoPath,
      branch: "matrix/e",
      baseBranch: "main",
    });
    await writeFile(join(workdir, ".gitattributes"), "* filter=evil\n");
    await writeFile(join(workdir, "README.md"), "changed");
    const port = new WorktreeGitPort({ trusted: ws.trusted });
    expect(await port.isClean(workdir)).toBe(false);
    await port.treeState(workdir);
    expect(existsSync(pwned)).toBe(false);
  });
});
