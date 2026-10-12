import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

/**
 * Reads a file an agent may have produced, without following symlinks anywhere below `root`:
 * every path component is lstat'ed, the file is opened with O_NOFOLLOW, and size is capped.
 */
export async function readInsideRoot(
  root: string,
  path: string,
  maxBytes = 64 * 1024 * 1024,
): Promise<Buffer> {
  const realRoot = await realpath(root);
  const rel = isAbsolute(path)
    ? ([relative(root, path), relative(realRoot, path)].find((r) => r && !r.startsWith("..")) ?? "")
    : normalize(path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`${path} is outside ${root}`);
  let current = realRoot;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`refusing to follow symlink ${current}`);
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${current} is not a regular file`);
    if (stat.size > maxBytes) throw new Error(`${current} exceeds ${maxBytes} bytes`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
