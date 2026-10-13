import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { FactoryToolingError, type PhaseContext } from "@matrix/core";
import { gitLocation, safeGitEnv } from "@matrix/sandbox";
import type { TrustedWorktrees, WorktreeGitPort } from "@matrix/workspace";
import type { PrivateStateOwner } from "../state-owner.js";

const execute = promisify(execFile);

export interface QaSnapshot {
  headSha: string;
  directory: string;
  materialize(directory: string): void;
}

export async function committedQaSnapshot(
  ctx: PhaseContext,
  git: WorktreeGitPort,
  trusted: TrustedWorktrees,
  owner?: PrivateStateOwner,
): Promise<QaSnapshot> {
  const signal = owner ? AbortSignal.any([ctx.signal, owner.signal]) : ctx.signal;
  const check = () => {
    signal.throwIfAborted();
    owner?.assertOwned();
  };
  check();
  const headSha = await git.cleanForChecks(ctx.workdir);
  check();
  const { gitdir } = await trusted.lookup(ctx.workdir);
  check();
  const read = async (...args: string[]) => {
    check();
    try {
      const result = await execute("git", [...gitLocation(gitdir), ...args], {
        cwd: gitdir,
        env: safeGitEnv(),
        signal,
        encoding: "buffer",
        maxBuffer: 16 * 1024 ** 2,
        timeout: 60_000,
      });
      check();
      return result.stdout;
    } catch {
      check();
      throw new FactoryToolingError(
        `QA committed snapshot ${args[0]} failed; verify trusted workspace metadata`,
      );
    }
  };
  const tree = (await read("ls-tree", "-r", "-z", headSha)).toString("utf8");
  const files: { path: string; mode: number; content: Buffer }[] = [];
  let bytes = 0;
  for (const record of tree.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, type, sha] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (
      tab < 0 ||
      !/^(100644|100755)$/.test(mode ?? "") ||
      type !== "blob" ||
      !sha ||
      !/^[a-f0-9]{40,64}$/.test(sha) ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
    )
      throw new FactoryToolingError(
        "QA snapshot refuses unsafe paths or non-regular committed files",
      );
    const content = await read("cat-file", "blob", sha);
    bytes += content.length;
    if (bytes > 128 * 1024 ** 2 || files.length >= 100_000)
      throw new FactoryToolingError("QA committed snapshot exceeds resource limits");
    files.push({ path, mode: mode === "100755" ? 0o755 : 0o644, content });
  }
  if ((await git.cleanForChecks(ctx.workdir)) !== headSha)
    throw new FactoryToolingError("QA source commit changed while preparing snapshot");
  check();
  const materialize = (directory: string) => {
    check();
    const withinWorktree = relative(ctx.workdir, directory);
    const containsWorktree = relative(directory, ctx.workdir);
    if (
      !isAbsolute(directory) ||
      !withinWorktree ||
      !containsWorktree ||
      !withinWorktree.startsWith("..") ||
      !containsWorktree.startsWith("..")
    )
      throw new FactoryToolingError("QA snapshot must be outside and not contain the worktree");
    for (const file of files) {
      check();
      mkdirSync(dirname(join(directory, file.path)), { recursive: true, mode: 0o700 });
      check();
      writeFileSync(join(directory, file.path), file.content, { mode: file.mode, flag: "wx" });
    }
  };
  const directory = await ctx.scratchDir();
  check();
  materialize(directory);
  return { headSha, directory, materialize };
}
