import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LineExecutor } from "@matrix/sandbox";
import { describe, expect, test } from "vitest";
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
    await expect(ws.prepare(target)).rejects.toThrow();
    await ws.cleanup(prepared);
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
