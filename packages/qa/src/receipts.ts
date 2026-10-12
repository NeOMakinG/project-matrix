import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Receipt, ReceiptKind } from "@matrix/core";
import { readInsideRoot } from "@matrix/sandbox";

/** Hashes an artifact. With `root` (agent-produced files) no symlink below root is followed. */
export async function sha256File(path: string, root?: string): Promise<string> {
  let bytes: Buffer;
  if (root) bytes = await readInsideRoot(root, path);
  else {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  return createHash("sha256").update(bytes).digest("hex");
}

/** A receipt bound to the exact bytes of an artifact on disk. */
export async function fileReceipt(
  kind: ReceiptKind,
  path: string,
  summary: string,
  ok = true,
  data?: unknown,
  root?: string,
): Promise<Receipt> {
  return {
    kind,
    ok,
    summary,
    path,
    sha256: await sha256File(path, root),
    ...(data !== undefined ? { data } : {}),
  };
}

export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "step"
  );
}
