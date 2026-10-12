import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

/**
 * Config forced on every host-side git call. Passed through GIT_CONFIG_COUNT so it outranks any repo
 * config and also reaches git processes spawned by other tools (gitleaks).
 */
export const SAFE_GIT_CONFIG: Array<[string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.attributesFile", "/dev/null"],
  ["submodule.recurse", "false"],
  ["status.submoduleSummary", "false"],
  ["diff.ignoreSubmodules", "all"],
  ["fetch.recurseSubmodules", "false"],
  ["core.untrackedCache", "false"],
  ["credential.helper", ""],
  ["core.sshCommand", "false"],
  ["core.pager", "cat"],
  ["diff.external", ""],
  ["protocol.allow", "never"],
  ["protocol.file.allow", "always"],
  ["uploadpack.packObjectsHook", ""],
];

/** Environment for host git: no system/global config, no replace objects, no prompts. */
export function safeGitEnv(
  extra: Record<string, string> = {},
  extraConfig: Array<[string, string]> = [],
): Record<string, string> {
  const config = [...SAFE_GIT_CONFIG, ...extraConfig];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return { ...env, ...extra };
}

/** Explicit repository location so git never discovers metadata from an agent-writable tree. */
export function gitLocation(gitDir: string, workTree?: string): string[] {
  return ["--git-dir", gitDir, ...(workTree ? ["--work-tree", workTree] : [])];
}

/**
 * Before any host git call on an agent-touched worktree: the worktree and its `.git` must not be
 * symlinks, and `.git` must be the pointer file git wrote, aimed at the host-owned gitdir.
 */
export async function verifyWorktreeLink(workdir: string, expectedGitDir: string): Promise<void> {
  const dirStat = await lstat(workdir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`worktree ${workdir} is not a plain directory`);
  }
  const marker = join(workdir, ".git");
  const markerStat = await lstat(marker);
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > 4096) {
    throw new Error(`worktree ${workdir} has a tampered .git entry`);
  }
  const pointer = (await readFile(marker, "utf8")).trim();
  const expected = await realpath(expectedGitDir);
  const target = pointer.startsWith("gitdir: ") ? pointer.slice(8).trim() : "";
  const resolved = target ? await realpath(target).catch(() => "") : "";
  if (resolved !== expected) {
    throw new Error(
      `worktree ${workdir} .git points to ${target || "nothing"}, expected ${expected}`,
    );
  }
}

/**
 * Lists every `.git` entry (file, dir or symlink) below the worktree root, excluding the root's own
 * `.git`. Agent-planted nested repos or submodules must never be touched by host git.
 */
export async function findNestedGitEntries(
  workdir: string,
  maxEntries = 500_000,
): Promise<string[]> {
  const found: string[] = [];
  const stack: string[] = [workdir];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      seen += 1;
      if (seen > maxEntries)
        throw new Error(`worktree ${workdir} has more than ${maxEntries} entries`);
      const full = join(dir, entry.name);
      if (entry.name === ".git") {
        if (dir !== workdir) found.push(full);
        continue;
      }
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return found;
}
