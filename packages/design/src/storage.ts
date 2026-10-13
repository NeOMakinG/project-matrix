import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { contentHash } from "@matrix/core";
import { assertNoSymlinkChain } from "@matrix/safe-fs";

export async function privateRoot(root: string): Promise<string> {
  if (!isAbsolute(root) || resolve(root) !== root)
    throw new Error("absolute canonical host root required");
  await assertNoSymlinkChain("/", root);
  const stat = await lstat(root);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw new Error("host root must be owned by current UID with mode 0700");
  if ((await realpath(root)) !== root) throw new Error("noncanonical host root");
  return root;
}
export async function readBounded(
  root: string,
  path: string,
  limit = 16 * 1024 * 1024,
): Promise<Buffer> {
  const rel = relative(root, path);
  if (!isAbsolute(path) || !rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("artifact outside authorized root");
  await assertNoSymlinkChain("/", dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit)
      throw new Error("invalid artifact size/type");
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error("artifact changed while reading");
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
export class ArtifactStore {
  constructor(readonly root: string) {}
  async put(bytes: Uint8Array, suffix: "png" | "json"): Promise<string> {
    await privateRoot(this.root);
    const path = join(this.root, `${contentHash(bytes)}.${suffix}`);
    let handle;
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (contentHash(await readBounded(this.root, path)) !== contentHash(bytes))
        throw new Error("artifact collision/tampering");
      return path;
    }
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return path;
  }
  async read(path: string): Promise<Buffer> {
    await privateRoot(this.root);
    return readBounded(this.root, path);
  }
}
export async function credentialFromStore(root: string, reference: string): Promise<string> {
  await privateRoot(root);
  if (!/^[a-zA-Z0-9_-]+$/.test(reference)) throw new Error("invalid credential reference");
  const path = join(root, reference);
  await assertNoSymlinkChain("/", path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 8192
    )
      throw new Error("credential must be UID-owned mode 0600 file");
    const token = (await handle.readFile("utf8")).trim();
    if (!/^[a-zA-Z0-9._~+/-]+=*$/.test(token)) throw new Error("invalid credential encoding");
    return token;
  } finally {
    await handle.close();
  }
}
