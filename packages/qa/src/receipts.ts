import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Receipt, ReceiptKind } from "@matrix/core";

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** A receipt bound to the exact bytes of an artifact on disk. */
export async function fileReceipt(
  kind: ReceiptKind,
  path: string,
  summary: string,
  ok = true,
  data?: unknown,
): Promise<Receipt> {
  return {
    kind,
    ok,
    summary,
    path,
    sha256: await sha256File(path),
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
