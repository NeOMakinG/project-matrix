import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const name = "@matrix/safe-fs";

export class UnsafePathError extends Error {}

const { O_WRONLY, O_RDONLY, O_CREAT, O_EXCL, O_APPEND, O_NOFOLLOW } = constants;

/** Joins `parts` under `base` and refuses absolute parts, `..`, NUL, or anything resolving outside `base`. */
export function safeJoin(base: string, ...parts: string[]): string {
  const root = resolve(base);
  for (const part of parts) {
    if (!part || isAbsolute(part) || part.includes("\0") || part.split(/[\\/]/).includes("..")) {
      throw new UnsafePathError(`unsafe path segment: ${JSON.stringify(part)}`);
    }
  }
  const target = resolve(root, ...parts);
  if (!target.startsWith(root + sep)) throw new UnsafePathError(`${target} escapes ${root}`);
  return target;
}

/** Real path of `path`, resolving the nearest existing ancestor when `path` itself does not exist yet. */
export async function realpathLoose(path: string): Promise<string> {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** True when `inner` is `outer` or below it, comparing real paths (symlinked ancestors are resolved). */
export async function isInsideReal(outer: string, inner: string): Promise<boolean> {
  const a = await realpathLoose(outer);
  const b = await realpathLoose(inner);
  const rel = relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Path components strictly below `base` leading to `target` (inclusive). */
function chain(base: string, target: string): string[] {
  const rel = relative(resolve(base), resolve(target));
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new UnsafePathError(`${target} is outside ${base}`);
  const out: string[] = [];
  let current = resolve(base);
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    out.push(current);
  }
  return out;
}

/** Throws if any existing component below `base` on the way to `target` is a symlink. */
export async function assertNoSymlinkChain(base: string, target: string): Promise<void> {
  for (const component of chain(base, target)) {
    try {
      if ((await lstat(component)).isSymbolicLink())
        throw new UnsafePathError(`${component} is a symlink`);
    } catch (error) {
      if (error instanceof UnsafePathError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

/** Creates `dir` under `base` one component at a time, refusing symlinks and non-directories. */
export async function ensureDir(base: string, dir: string): Promise<void> {
  for (const component of chain(base, dir)) {
    try {
      await mkdir(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const st = await lstat(component);
    if (st.isSymbolicLink()) throw new UnsafePathError(`${component} is a symlink`);
    if (!st.isDirectory()) throw new UnsafePathError(`${component} is not a directory`);
  }
}

/**
 * Atomic write of `target` (which must be below `base`): parent chain created without following symlinks,
 * data written to a random exclusive temp file opened with O_EXCL|O_NOFOLLOW in the same directory,
 * fsynced, then renamed over the target. A symlinked target is refused rather than replaced.
 */
export async function writeFileSafe(
  base: string,
  target: string,
  data: string | Uint8Array,
  opts: { mode?: number } = {},
): Promise<void> {
  const dir = dirname(target);
  await ensureDir(base, dir);
  const tmp = join(dir, `.${basename(target)}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, opts.mode ?? 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      if ((await lstat(target)).isSymbolicLink())
        throw new UnsafePathError(`${target} is a symlink`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await assertNoSymlinkChain(base, dir);
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Appends to `target` below `base`, creating it if needed, never following a symlink at any level. */
export async function appendFileSafe(base: string, target: string, data: string): Promise<void> {
  await ensureDir(base, dirname(target));
  const handle = await open(target, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** Reads `target` below `base` without following symlinks; `null` when missing. */
export async function readFileSafe(
  base: string,
  target: string,
  opts: { maxBytes?: number } = {},
): Promise<string | null> {
  safeJoin(base, relative(resolve(base), resolve(target)));
  await assertNoSymlinkChain(base, dirname(target));
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(target, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new UnsafePathError(`${target} is a symlink`);
    throw error;
  }
  try {
    if (opts.maxBytes !== undefined) {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > opts.maxBytes)
        throw new Error("file exceeds read limit or is not a regular file");
      const buffer = Buffer.alloc(opts.maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > opts.maxBytes) throw new Error("file exceeds read limit");
      return buffer.subarray(0, length).toString("utf8");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
