import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class SafePathError extends Error {
  override name = "SafePathError";
}

const lstatOrNull = async (p: string) => {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
};

/** Throws unless `target` is inside `root` and no existing component from root to target is a symlink. */
export async function assertSafePath(root: string, target: string): Promise<void> {
  const rel = relative(resolve(root), resolve(target));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new SafePathError(`refusing ${target}: outside ${root}`);
  }
  let cur = resolve(root);
  const rootStat = await lstatOrNull(cur);
  if (rootStat?.isSymbolicLink()) throw new SafePathError(`refusing ${root}: root is a symlink`);
  for (const part of rel === "" ? [] : rel.split(sep)) {
    cur = join(cur, part);
    const s = await lstatOrNull(cur);
    if (s?.isSymbolicLink()) throw new SafePathError(`refusing ${target}: ${cur} is a symlink`);
  }
}

/** Creates `dir` one component at a time, refusing symlinked or non-directory components. */
export async function ensureSafeDir(root: string, dir: string): Promise<void> {
  await assertSafePath(root, dir);
  let cur = resolve(root);
  for (const part of relative(resolve(root), resolve(dir)).split(sep).filter(Boolean)) {
    cur = join(cur, part);
    const s = await lstatOrNull(cur);
    if (!s) {
      try {
        await mkdir(cur);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    const after = await lstat(cur);
    if (after.isSymbolicLink() || !after.isDirectory()) {
      throw new SafePathError(`refusing ${dir}: ${cur} is a symlink or not a directory`);
    }
  }
}

const { O_WRONLY, O_RDONLY, O_CREAT, O_EXCL, O_TRUNC, O_NOFOLLOW } = constants;

/** Creates a new file; fails if it exists. O_EXCL + O_NOFOLLOW: never follows a final symlink. */
export async function writeNewFile(root: string, path: string, data: string): Promise<void> {
  await assertSafePath(root, path);
  const handle = await open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** Replaces an existing regular file without following a final symlink. */
export async function overwriteFile(root: string, path: string, data: string): Promise<void> {
  await assertSafePath(root, path);
  const handle = await open(path, O_WRONLY | O_TRUNC | O_NOFOLLOW);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

export async function readFileSafe(root: string, path: string): Promise<string> {
  await assertSafePath(root, path);
  const handle = await open(path, O_RDONLY | O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
