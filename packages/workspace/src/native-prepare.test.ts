import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { hostExecutor, type LineExecutor } from "@matrix/sandbox";
import { expect, test } from "vitest";
import { WorktreeGitPort } from "./git-port.js";
import { NativeWorkspace } from "./native.js";

test.each(["absolute", "relative"])(
  "fresh Matrix dataDir (%s root) prepares before any missing-root spawn and records trusted metadata",
  async (rootKind) => {
    const directory = await mkdtemp(join(tmpdir(), "matrix-fresh-native-"));
    try {
      const canonical = await realpath(directory);
      const repoPath = join(canonical, "repo");
      const commonDir = join(repoPath, ".git");
      await mkdir(commonDir, { recursive: true });
      const root = join(canonical, "new-data-dir", "worktrees");
      expect(existsSync(root)).toBe(false);
      const calls: Array<{ cwd: string; binary: string }> = [];
      const sha = "a".repeat(40);
      const executor: LineExecutor = async (spec, onLine, signal) => {
        calls.push({ cwd: spec.cwd, binary: spec.cmd[0]! });
        const outcome = await hostExecutor(
          { ...spec, cmd: [process.execPath, "-e", ""] },
          () => {},
          signal,
        );
        if (spec.cmd.includes("worktree") && spec.cmd.includes("add")) {
          const workdir = spec.cmd[spec.cmd.indexOf("--") + 1]!;
          const gitdir = join(commonDir, "worktrees", "fixture");
          await mkdir(workdir, { recursive: true });
          await mkdir(gitdir, { recursive: true });
          await writeFile(join(gitdir, "gitdir"), `${join(workdir, ".git")}\n`);
          await writeFile(join(workdir, ".git"), `gitdir: ${gitdir}\n`);
        }
        if (spec.cmd.includes("rev-parse")) onLine(sha);
        if (spec.cmd.includes("symbolic-ref")) onLine("matrix/T-0001");
        return outcome;
      };
      const workspace = new NativeWorkspace({
        root: rootKind === "relative" ? relative(process.cwd(), root) : root,
        executor,
        gitBinary: "/usr/bin/git",
      });
      const prepared = await workspace.prepare({
        projectId: "fixture",
        ticketId: "T-0001",
        repoPath,
        branch: "matrix/T-0001",
        baseBranch: "main",
      });
      expect(calls[0]).toEqual({ cwd: commonDir, binary: "/usr/bin/git" });
      expect(prepared.workdir).toBe(join(root, "fixture", "T-0001"));
      const trusted = await workspace.trusted.lookup(prepared.workdir);
      expect(trusted).toMatchObject({ commonDir, baseSha: sha });
      expect(trusted.gitdir.startsWith(`${commonDir}/worktrees/`)).toBe(true);
      expect(await readFile(join(root, ".matrix", "worktrees.json"), "utf8")).toContain(sha);
      const git = new WorktreeGitPort({ trusted: workspace.trusted, executor });
      expect(await git.headSha(prepared.workdir)).toBe(sha);
      expect(calls.at(-1)?.cwd).toBe(trusted.gitdir);
      await writeFile(join(prepared.workdir, ".git"), "gitdir: /invalid/metadata\n");
      const before = calls.length;
      await expect(git.headSha(prepared.workdir)).rejects.toThrow();
      expect(calls).toHaveLength(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("fresh-root preparation still refuses symlinked canonical metadata before any host launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "matrix-native-root-gate-"));
  try {
    const repoPath = join(directory, "repo");
    const metadata = join(directory, "metadata");
    await mkdir(repoPath);
    await mkdir(metadata);
    await symlink(metadata, join(repoPath, ".git"));
    let launched = false;
    const executor: LineExecutor = async () => {
      launched = true;
      throw new Error("unexpected host launch");
    };
    const workspace = new NativeWorkspace({
      root: join(directory, "new-data", "worktrees"),
      executor,
    });
    await expect(
      workspace.prepare({
        projectId: "fixture",
        ticketId: "ticket",
        repoPath,
        branch: "matrix/ticket",
        baseBranch: "main",
      }),
    ).rejects.toThrow("canonical git repository");
    expect(launched).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
