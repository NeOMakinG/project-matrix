import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { LOCKFILES, realFile } from "./setup-detect.js";

/** Copies a tree without following symlinks (reflinks where the filesystem supports them). */
export type TreeCopy = (from: string, to: string) => Promise<void>;

export const copyTree: TreeCopy = async (from, to) => {
  const flags = process.platform === "linux" ? ["-a", "--reflink=auto"] : ["-a"];
  await promisify(execFile)("cp", [...flags, "--", from, to], { maxBuffer: 1024 * 1024 });
};

const KEEP_PER_PROJECT = 3;
/** Package-manager config that changes what an install produces (hashed into the key). */
const INSTALL_CONFIG = [".npmrc", ".yarnrc", ".yarnrc.yml", "pnpm-workspace.yaml", ".pnpmfile.cjs"];
const MAX_DEPTH = 6;

/** Every directory on the way to `rel` (included) is a real directory, never a symlink. */
export async function realDir(workdir: string, rel: string): Promise<boolean> {
  if (rel === ".") return true;
  const segments = rel.split("/");
  for (let index = 1; index <= segments.length; index++) {
    const s = await lstat(join(workdir, ...segments.slice(0, index))).catch(() => undefined);
    if (!s || s.isSymbolicLink() || !s.isDirectory()) return false;
  }
  return true;
}

/**
 * Cache key of one setup step: project, cwd, argv and the exact manifest + lockfile bytes. No
 * lockfile: undefined (an unpinned install is never cached).
 */
export async function cacheKey(
  workdir: string,
  projectId: string,
  cwd: string,
  run: readonly string[],
): Promise<string | undefined> {
  const hash = createHash("sha256").update(JSON.stringify({ projectId, cwd, run }));
  let pinned = false;
  const inputs = [
    ...["package.json", ...LOCKFILES, ...INSTALL_CONFIG].map((f) =>
      cwd === "." ? f : `${cwd}/${f}`,
    ),
    ...(cwd === "." ? [] : INSTALL_CONFIG),
  ];
  for (const rel of inputs) {
    const file = rel.split("/").at(-1) as string;
    if (!(await realFile(workdir, rel))) continue;
    if (LOCKFILES.includes(file)) pinned = true;
    hash.update(`\0${file}\0`).update(await readFile(join(workdir, rel)));
  }
  return pinned ? hash.digest("hex") : undefined;
}

/** `node_modules` directories under `cwd` (relative to the worktree), not descending into them. */
export async function dependencyDirs(workdir: string, cwd: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string, depth: number) => {
    const entries = await readdir(join(workdir, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = rel === "." ? entry.name : `${rel}/${entry.name}`;
      if (entry.name === "node_modules") out.push(child);
      else if (entry.isDirectory() && !entry.name.startsWith(".") && depth < MAX_DEPTH)
        await walk(child, depth + 1);
    }
  };
  await walk(cwd, 0);
  return out.sort();
}

export const projectCacheDir = (root: string, projectId: string) =>
  join(root, createHash("sha256").update(projectId).digest("hex").slice(0, 32));

/** Restores a cached install into the worktree; false when there is no complete entry. */
export async function restoreInstall(
  entry: string,
  workdir: string,
  copy: TreeCopy = copyTree,
): Promise<string[] | false> {
  const manifest = await readFile(join(entry, "manifest.json"), "utf8").catch(() => undefined);
  if (manifest === undefined) return false;
  const dirs = JSON.parse(manifest) as string[];
  for (const rel of dirs) {
    const parent = rel.split("/").slice(0, -1).join("/") || ".";
    if (!/(^|\/)node_modules$/.test(rel) || !(await realDir(workdir, parent)))
      throw new Error(`cached dependency path no longer fits the worktree: ${rel}`);
  }
  try {
    for (const [index, rel] of dirs.entries()) {
      await rm(join(workdir, rel), { recursive: true, force: true });
      await copy(join(entry, String(index)), join(workdir, rel));
    }
  } catch (error) {
    // Never leave a partial tree a non-wiping installer could take as up to date.
    for (const rel of dirs) await rm(join(workdir, rel), { recursive: true, force: true });
    throw error;
  }
  const now = new Date();
  await utimes(entry, now, now).catch(() => undefined); // eviction is least recently used
  return dirs;
}

/** Stores a fresh install (atomic rename) and keeps the newest entries of the project. */
export async function storeInstall(
  projectDir: string,
  key: string,
  workdir: string,
  dirs: string[],
  copy: TreeCopy = copyTree,
): Promise<void> {
  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  const staging = join(projectDir, `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const [index, rel] of dirs.entries())
      await copy(join(workdir, rel), join(staging, String(index)));
    await writeFile(join(staging, "manifest.json"), JSON.stringify(dirs));
    await rename(staging, join(projectDir, key)).catch(() => undefined);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const entries = await readdir(projectDir).catch(() => [] as string[]);
  const dated = await Promise.all(
    entries
      .filter((name) => !name.startsWith("."))
      .map(async (name) => ({ name, at: (await stat(join(projectDir, name))).mtimeMs })),
  );
  for (const old of dated.sort((a, b) => b.at - a.at).slice(KEEP_PER_PROJECT))
    await rm(join(projectDir, old.name), { recursive: true, force: true });
}
