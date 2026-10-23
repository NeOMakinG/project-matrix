import { constants } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Hard ceiling on a report a check may hand back (the per-call `maxBytes` is clamped to it). */
export const MAX_REPORT_BYTES = 256 * 1024 * 1024;
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$/;

export type ReportResult = { text: string } | { error: string };

/** A fresh host-only (0700) directory to mount at REPORT_MOUNT; removed by `cleanup`. */
export async function reportDir(name: string): Promise<{ dir: string; cleanup(): Promise<void> }> {
  if (!NAME.test(name)) throw new Error("invalid report file name");
  const dir = await mkdtemp(join(tmpdir(), "matrix-report-"));
  await chmod(dir, 0o700);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Reads `<dir>/<name>` after the sandbox exited. The sandbox could have planted anything there:
 * symlinks are refused (O_NOFOLLOW), FIFOs cannot block (O_NONBLOCK), only a single-link regular
 * file is read, and never more than `maxBytes`.
 */
export async function readReport(
  dir: string,
  name: string,
  maxBytes: number,
): Promise<ReportResult> {
  if (!NAME.test(name)) return { error: "invalid report file name" };
  const cap = Math.max(0, Math.min(Math.floor(maxBytes), MAX_REPORT_BYTES));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      join(dir, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) return { error: "report is not a regular file" };
    if (stat.size > cap) return { error: `report exceeds ${cap} bytes` };
    const buffer = Buffer.alloc(Math.min(stat.size, cap) + 1);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    if (read > cap) return { error: `report exceeds ${cap} bytes` };
    return { text: buffer.subarray(0, read).toString("utf8") };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return { error: "no report written" };
    if (code === "ELOOP") return { error: "report is a symlink" };
    return { error: `report unreadable (${typeof code === "string" ? code : "error"})` };
  } finally {
    await handle?.close();
  }
}
