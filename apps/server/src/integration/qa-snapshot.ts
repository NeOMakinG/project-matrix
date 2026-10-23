import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { type PhaseContext, vouchedToolingError } from "@matrix/core";
import { gitLocation, safeGitEnv } from "@matrix/sandbox";
import type { TrustedWorktrees, WorktreeGitPort } from "@matrix/workspace";
import type { PrivateStateOwner } from "../state-owner.js";

const execute = promisify(execFile);

/** Committed files above this size are materialized as empty placeholders (path kept). */
export const QA_SNAPSHOT_MAX_FILE_BYTES = 4 * 1024 ** 2;
/** Media/model/font assets probes never need as bytes: placeholders keep imports resolvable. */
const BINARY_ASSET =
  /\.(?:png|jpe?g|gif|webp|avif|heic|bmp|ico|tiff?|mp4|webm|mov|m4v|avi|mp3|wav|m4a|aac|ogg|flac|onnx|tflite|mlmodel|bin|pt|pth|safetensors|otf|ttf|woff2?|eot|pdf|zip|gz|tgz|xz|7z|jar|aar|apk|aab|ipa|so|dylib|a|db|sqlite|db-wal|db-shm)$/i;

export function qaSnapshotPlaceholder(path: string, size: number): boolean {
  return size > QA_SNAPSHOT_MAX_FILE_BYTES || BINARY_ASSET.test(path);
}

export interface QaSnapshot {
  headSha: string;
  /** Committed files materialized empty (binary assets or above the per-file cap). */
  placeholders?: number;
  /** Up to 100 placeholder paths, so the planner never asserts on emptied files. */
  placeholderPaths?: string[];
  directory: string;
  materialize(directory: string): void;
}

export async function committedQaSnapshot(
  ctx: PhaseContext,
  git: WorktreeGitPort,
  trusted: TrustedWorktrees,
  owner?: PrivateStateOwner,
): Promise<QaSnapshot> {
  const signal = owner ? AbortSignal.any([ctx.signal, owner.signal]) : ctx.signal;
  const check = () => {
    signal.throwIfAborted();
    owner?.assertOwned();
  };
  check();
  const headSha = await git.cleanForChecks(ctx.workdir);
  check();
  const { gitdir } = await trusted.lookup(ctx.workdir);
  check();
  const read = async (...args: string[]) => {
    check();
    try {
      const result = await execute("git", [...gitLocation(gitdir), ...args], {
        cwd: gitdir,
        env: safeGitEnv(),
        signal,
        encoding: "buffer",
        maxBuffer: 16 * 1024 ** 2,
        timeout: 60_000,
      });
      check();
      return result.stdout;
    } catch (error) {
      check();
      const code = (error as { code?: unknown }).code;
      const reason =
        code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? "output exceeded the snapshot buffer"
          : (error as { killed?: boolean }).killed
            ? "timed out"
            : typeof code === "number"
              ? `git exit ${code}`
              : "git unavailable";
      throw vouchedToolingError(
        `QA committed snapshot ${args[0]} failed (${reason}); verify trusted workspace metadata`,
      );
    }
  };
  const tree = (await read("ls-tree", "-r", "-z", "-l", headSha)).toString("utf8");
  const files: { path: string; mode: number; content: Buffer }[] = [];
  let bytes = 0;
  let placeholders = 0;
  const placeholderPaths: string[] = [];
  for (const record of tree.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, type, sha, sizeText] = record.slice(0, tab).split(/ +/);
    const path = record.slice(tab + 1);
    const size = Number(sizeText);
    if (
      tab < 0 ||
      !/^(100644|100755)$/.test(mode ?? "") ||
      type !== "blob" ||
      !sha ||
      !/^[a-f0-9]{40,64}$/.test(sha) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
    )
      throw vouchedToolingError("QA snapshot refuses unsafe paths or non-regular committed files");
    // Large and binary assets (models, media, fonts) are never read: an empty file keeps the path
    // importable while the snapshot stays within memory and size limits.
    const placeholder = qaSnapshotPlaceholder(path, size);
    if (placeholder && ++placeholders <= 100) placeholderPaths.push(path);
    const content = placeholder ? Buffer.alloc(0) : await read("cat-file", "blob", sha);
    bytes += content.length;
    if (bytes > 128 * 1024 ** 2 || files.length >= 100_000)
      throw vouchedToolingError("QA committed snapshot exceeds resource limits");
    files.push({ path, mode: mode === "100755" ? 0o755 : 0o644, content });
  }
  if ((await git.cleanForChecks(ctx.workdir)) !== headSha)
    throw vouchedToolingError("QA source commit changed while preparing snapshot");
  check();
  const materialize = (directory: string) => {
    check();
    const withinWorktree = relative(ctx.workdir, directory);
    const containsWorktree = relative(directory, ctx.workdir);
    if (
      !isAbsolute(directory) ||
      !withinWorktree ||
      !containsWorktree ||
      !withinWorktree.startsWith("..") ||
      !containsWorktree.startsWith("..")
    )
      throw vouchedToolingError("QA snapshot must be outside and not contain the worktree");
    for (const file of files) {
      check();
      mkdirSync(dirname(join(directory, file.path)), { recursive: true, mode: 0o700 });
      check();
      writeFileSync(join(directory, file.path), file.content, { mode: file.mode, flag: "wx" });
    }
  };
  const directory = await ctx.scratchDir();
  check();
  materialize(directory);
  return { headSha, directory, materialize, placeholders, placeholderPaths };
}
