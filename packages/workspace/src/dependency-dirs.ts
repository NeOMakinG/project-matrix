import { lstat, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Installed dependencies (`node_modules`) are disposable run state: never committed, never part of
 * the handover fingerprint, and wiped before checks so whatever an agent planted there cannot make
 * checks pass. Dependency setup reinstalls them from the lockfile right after.
 */
export const isDependencyPath = (path: string) => path.split("/").includes("node_modules");

/** `a/node_modules` for `a/node_modules/x/y.js`: the outermost dependency directory. */
export function dependencyRoot(path: string): string | undefined {
  const segments = path.split("/");
  const index = segments.indexOf("node_modules");
  return index < 0 ? undefined : segments.slice(0, index + 1).join("/");
}

/** Every directory from the worktree to `rel`'s parent must be a real directory, not a symlink. */
async function assertRealParents(workdir: string, rel: string): Promise<void> {
  const segments = rel.split("/");
  for (let index = 1; index < segments.length; index++) {
    const stat = await lstat(join(workdir, ...segments.slice(0, index)));
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`dependency path escapes the worktree: ${rel}`);
  }
}

/**
 * Deletes untracked dependency files. Roots without tracked content are removed whole (a symlinked
 * root only loses the link); vendored roots only lose their untracked files.
 */
export async function removeDependencyDirs(
  workdir: string,
  untracked: string[],
  tracked: ReadonlySet<string>,
): Promise<number> {
  const roots = new Map<string, string[]>();
  for (const path of untracked) {
    const root = dependencyRoot(path);
    if (!root || root.split("/").some((s) => s === ".." || s === "")) continue;
    roots.set(root, [...(roots.get(root) ?? []), path]);
  }
  const vendored = new Set<string>();
  for (const path of tracked) {
    const root = dependencyRoot(path);
    if (root && roots.has(root)) vendored.add(root);
  }
  for (const [root, files] of roots) {
    await assertRealParents(workdir, root);
    if (!vendored.has(root)) {
      await rm(join(workdir, root), { recursive: true, force: true });
      continue;
    }
    for (const file of files) {
      await assertRealParents(workdir, file);
      await unlink(join(workdir, file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  return roots.size;
}
