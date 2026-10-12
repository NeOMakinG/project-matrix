import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ensureSafeDir,
  overwriteFile,
  SafePathError,
  writeNewFile,
} from "@matrix/tickets/adapters/safe-fs";

export { SafePathError };

export interface PlanResult {
  /** Paths that would be created. */
  create: string[];
  /** Paths that already exist as regular files. */
  existing: string[];
  /** Paths that must never be written (symlinks, escapes, non-files). */
  refused: { path: string; reason: string }[];
}

const exists = async (p: string) => {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
};

/** Every component between root and the target must be a real directory (no symlinks). */
async function symlinkOnPath(root: string, target: string): Promise<string | null> {
  const parts = relative(root, target).split(sep);
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    const s = await exists(cur);
    if (s?.isSymbolicLink()) return relative(root, cur);
    if (s && !s.isDirectory()) return relative(root, cur);
  }
  return null;
}

export async function planWrites(outDir: string, paths: string[]): Promise<PlanResult> {
  const root = await realpath(outDir);
  const plan: PlanResult = { create: [], existing: [], refused: [] };
  for (const path of paths) {
    const target = resolve(root, path);
    if (isAbsolute(path) || relative(root, target).startsWith("..") || target === root) {
      plan.refused.push({ path, reason: "path escapes the target directory" });
      continue;
    }
    const badParent = await symlinkOnPath(root, target);
    if (badParent) {
      plan.refused.push({ path, reason: `${badParent} is a symlink or not a directory` });
      continue;
    }
    const s = await exists(target);
    if (!s) plan.create.push(path);
    else if (s.isSymbolicLink()) plan.refused.push({ path, reason: "target is a symlink" });
    else if (!s.isFile()) plan.refused.push({ path, reason: "target is not a regular file" });
    else plan.existing.push(path);
  }
  return plan;
}

/**
 * Writes files under outDir. Never follows symlinks or escapes outDir.
 * Existing files are only replaced when `overwrite` is true.
 */
export async function safeWrite(
  outDir: string,
  files: Record<string, string>,
  opts: { overwrite: boolean },
): Promise<{ written: string[]; skipped: string[] }> {
  const plan = await planWrites(outDir, Object.keys(files));
  if (plan.refused.length > 0) {
    throw new SafePathError(
      `refusing to write: ${plan.refused.map((r) => `${r.path} (${r.reason})`).join(", ")}`,
    );
  }
  const root = await realpath(outDir);
  const toWrite = opts.overwrite ? [...plan.create, ...plan.existing] : plan.create;
  for (const path of toWrite) {
    const target = resolve(root, path);
    // Component-wise mkdir + O_NOFOLLOW/O_EXCL opens: the final component is never followed and the
    // parents are re-checked right before each write, which shrinks the plan-then-write race.
    await ensureSafeDir(root, dirname(target));
    if (plan.create.includes(path)) await writeNewFile(root, target, files[path] as string);
    else await overwriteFile(root, target, files[path] as string);
  }
  return { written: toWrite.sort(), skipped: opts.overwrite ? [] : plan.existing.sort() };
}
