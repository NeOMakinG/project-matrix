import { spawnSync } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import picomatch from "picomatch";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Root-level paths that are never project source: factory output and the CI tool checkout.
 * Nothing is skipped by basename at depth; everything else follows git (or `.gitignore`).
 */
const ROOT_EXCLUDES = [".git", ".matrix", ".matrix-tool"];

/** Repo-relative POSIX path. */
export const toPosix = (p: string) => p.split(sep).join("/");

export const isSource = (path: string) => SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));

export const isDeclaration = (path: string) => /\.d\.[cm]?ts$/.test(path);

const rootExcluded = (rel: string) =>
  ROOT_EXCLUDES.some((d) => rel === d || rel.startsWith(`${d}/`));

/** A symlink inside the project pointing outside it. Checks treat it as a violation. */
export interface SymlinkEscape {
  path: string;
  target: string;
}

export interface SourceListing {
  files: string[];
  escapes: SymlinkEscape[];
  /** How files were discovered. */
  via: "git" | "walk";
}

/** Converts `.gitignore` lines to picomatch globs (git semantics, negation unsupported). */
export function gitignoreGlobs(text: string): string[] {
  const globs: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const dirOnly = line.endsWith("/");
    let pat = line.replace(/\/+$/, "");
    const anchored = pat.startsWith("/") || pat.includes("/");
    pat = pat.replace(/^\//, "");
    const base = anchored ? pat : `**/${pat}`;
    globs.push(`${base}/**`);
    if (!dirOnly) globs.push(base);
  }
  return globs;
}

function gitListing(root: string): string[] | undefined {
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0 || r.error) return undefined;
  return r.stdout.split("\0").filter(Boolean);
}

async function walkListing(root: string): Promise<string[]> {
  const ignoreText = await readFile(join(root, ".gitignore"), "utf8").catch(() => "");
  const ignored = picomatch(gitignoreGlobs(ignoreText), { dot: true });
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = toPosix(relative(root, join(dir, e.name)));
      if (rootExcluded(rel) || ignored(rel)) continue;
      if (e.isDirectory()) await walk(join(dir, e.name));
      else out.push(rel);
    }
  }
  await walk(root);
  return out;
}

/**
 * Lists every source file a check must see. In a git repo: tracked plus untracked-not-ignored
 * files (`git ls-files`), so committed code in `build/` or `dist/` is never hidden. Outside git:
 * a walk honouring the root `.gitignore`. Symlinks resolving outside `root` are reported.
 */
export async function scanSources(root: string): Promise<SourceListing> {
  const fromGit = gitListing(root);
  const candidates = (fromGit ?? (await walkListing(root))).map(toPosix);
  const realRoot = await realpath(root);
  const files: string[] = [];
  const escapes: SymlinkEscape[] = [];
  for (const rel of candidates) {
    if (rootExcluded(rel)) continue;
    const abs = join(root, rel);
    const st = await lstat(abs).catch(() => undefined);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      const target = await realpath(abs).catch(() => undefined);
      const inside = target ? relative(realRoot, target) : undefined;
      if (!target || inside === undefined || inside.startsWith("..") || isAbsolute(inside)) {
        escapes.push({ path: rel, target: target ?? "(dangling)" });
        continue;
      }
      const tst = await lstat(target);
      if (tst.isDirectory()) continue;
    } else if (!st.isFile()) continue;
    if (isSource(rel) && !isDeclaration(rel)) files.push(rel);
  }
  return {
    files: [...new Set(files)].sort(),
    escapes: escapes.sort((a, b) => a.path.localeCompare(b.path)),
    via: fromGit ? "git" : "walk",
  };
}

/** Source files under `root`, sorted, as repo-relative POSIX paths. */
export async function listSourceFiles(root: string): Promise<string[]> {
  return (await scanSources(root)).files;
}

export interface Scope {
  files?: string[] | undefined;
  except?: string[] | undefined;
}

/** True when `path` falls in the scope: matches `files` (default: everything) and no `except`. */
export function inScope(path: string, scope: Scope): boolean {
  const include = scope.files && scope.files.length > 0 ? scope.files : ["**"];
  if (!picomatch(include, { dot: true })(path)) return false;
  return !(scope.except && scope.except.length > 0 && picomatch(scope.except, { dot: true })(path));
}
