import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class UnsafePathError extends Error {}

/** Joins `name` under `base` and refuses anything that resolves outside it. */
export function safeJoin(base: string, ...parts: string[]): string {
  const root = resolve(base);
  for (const part of parts) {
    if (!part || isAbsolute(part) || part.includes("\0") || part.split(/[\\/]/).includes("..")) {
      throw new UnsafePathError(`unsafe path segment: ${JSON.stringify(part)}`);
    }
  }
  const target = resolve(root, ...parts);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !target.startsWith(root + sep)) {
    throw new UnsafePathError(`${target} escapes ${root}`);
  }
  return target;
}

/** Throws if `path` (or any existing parent below `base`) is a symlink. Missing paths are fine. */
export async function assertNoSymlink(base: string, path: string): Promise<void> {
  const root = resolve(base);
  let current = resolve(path);
  while (current.startsWith(root + sep) || current === root) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new UnsafePathError(`${current} is a symlink`);
    } catch (error) {
      if (error instanceof UnsafePathError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === root) break;
    current = resolve(current, "..");
  }
}

/** True when `inner` is `outer` or inside it. */
export function isInside(outer: string, inner: string): boolean {
  const rel = relative(resolve(outer), resolve(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
