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

/** Non-JS files that text rules (regex, required-header) also scan: Go, Rust, config, SQL. */
export const TEXT_EXTENSIONS = [".go", ".rs", ".json", ".toml", ".yaml", ".yml", ".sql"];

export const isText = (path: string) => TEXT_EXTENSIONS.some((ext) => path.endsWith(ext));

export const isDeclaration = (path: string) => /\.d\.[cm]?ts$/.test(path);

const rootExcluded = (rel: string) =>
  ROOT_EXCLUDES.some((d) => rel === d || rel.startsWith(`${d}/`));

/** A symlink inside the project pointing outside it. Checks treat it as a violation. */
export interface SymlinkEscape {
  path: string;
  target: string;
}

/** A git submodule or nested repository. Its files are only listed when explicitly allowed. */
export interface NestedRepo {
  path: string;
  /** False when the folder is missing or empty (submodule not checked out). */
  populated: boolean;
  /** True when its files were included in the listing. */
  included: boolean;
}

export interface SourceListing {
  files: string[];
  /** Non-JS text files (see TEXT_EXTENSIONS), for regex and header rules. */
  textFiles: string[];
  escapes: SymlinkEscape[];
  submodules: NestedRepo[];
  /** How files were discovered. */
  via: "git" | "walk";
}

export interface ScanOptions {
  /** Submodule paths whose files are listed (recursively). Others are only reported. */
  includeSubmodule?: (path: string) => boolean;
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

const gitOut = (root: string, args: string[]) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 && !r.error ? r.stdout : undefined;
};

/** Splits `git ... -z` output into records. */
export const nulEntries = (out: string | undefined) => (out ?? "").split("\0").filter(Boolean);

interface GitListing {
  paths: string[];
  /** Gitlinks (mode 160000), `.gitmodules` paths and untracked nested repositories. */
  nested: string[];
}

function gitListing(root: string): GitListing | undefined {
  const out = gitOut(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (out === undefined) return undefined;
  const nested = new Set<string>();
  for (const entry of nulEntries(gitOut(root, ["ls-files", "-z", "--stage"]))) {
    // "<mode> <object> <stage>\t<path>": split at the first tab; the path may hold any byte.
    const tab = entry.indexOf("\t");
    if (tab !== -1 && entry.startsWith("160000 ")) nested.add(entry.slice(tab + 1));
  }
  // `-z`: each record is "<key>\n<value>\0", so paths with newlines survive.
  for (const record of nulEntries(
    gitOut(root, ["config", "-z", "-f", ".gitmodules", "--get-regexp", "path$"]),
  )) {
    const nl = record.indexOf("\n");
    const path = nl === -1 ? "" : record.slice(nl + 1);
    if (path) nested.add(path.replace(/\/+$/, ""));
  }
  const paths: string[] = [];
  for (const p of nulEntries(out)) {
    // `--others` reports an untracked nested repository as a single `dir/` entry.
    if (p.endsWith("/")) nested.add(p.replace(/\/+$/, ""));
    else if (!nested.has(p)) paths.push(p);
  }
  return { paths, nested: [...nested].sort() };
}

async function walkListing(root: string): Promise<GitListing> {
  const ignoreText = await readFile(join(root, ".gitignore"), "utf8").catch(() => "");
  const ignored = picomatch(gitignoreGlobs(ignoreText), { dot: true });
  const paths: string[] = [];
  const nested: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = toPosix(relative(root, join(dir, e.name)));
      if (rootExcluded(rel) || ignored(rel)) continue;
      if (e.isDirectory()) {
        const isRepo = await lstat(join(dir, e.name, ".git")).then(
          () => true,
          () => false,
        );
        if (isRepo) nested.push(rel);
        else await walk(join(dir, e.name));
      } else paths.push(rel);
    }
  }
  await walk(root);
  return { paths, nested: nested.sort() };
}

/**
 * Lists every source file a check must see. In a git repo: tracked plus untracked-not-ignored
 * files (`git ls-files`), so committed code in `build/` or `dist/` is never hidden. Outside git:
 * a walk honouring the root `.gitignore`. Symlinks resolving outside `root` are reported.
 * Submodules and nested repositories are reported, and listed only when `includeSubmodule`
 * allows them.
 */
export async function scanSources(root: string, opts: ScanOptions = {}): Promise<SourceListing> {
  const realTop = await realpath(root);
  const files: string[] = [];
  const textFiles: string[] = [];
  const escapes: SymlinkEscape[] = [];
  const submodules: NestedRepo[] = [];
  let via: SourceListing["via"] = "walk";

  const scan = async (dir: string, prefix: string, top: boolean): Promise<void> => {
    const fromGit = gitListing(dir);
    if (top) via = fromGit ? "git" : "walk";
    const listing = fromGit ?? (await walkListing(dir));
    for (const raw of listing.paths) {
      const rel = toPosix(raw);
      if (top && rootExcluded(rel)) continue;
      const full = prefix + rel;
      const abs = join(dir, rel);
      const st = await lstat(abs).catch(() => undefined);
      if (!st) continue;
      if (st.isSymbolicLink()) {
        const target = await realpath(abs).catch(() => undefined);
        const inside = target ? relative(realTop, target) : undefined;
        if (!target || inside === undefined || inside.startsWith("..") || isAbsolute(inside)) {
          escapes.push({ path: full, target: target ?? "(dangling)" });
          continue;
        }
        if ((await lstat(target)).isDirectory()) continue;
      } else if (!st.isFile()) continue;
      if (isSource(rel) && !isDeclaration(rel)) files.push(full);
      else if (isText(rel)) textFiles.push(full);
    }
    for (const sub of listing.nested) {
      const full = prefix + sub;
      const entries = await readdir(join(dir, sub)).catch(() => [] as string[]);
      const populated = entries.some((e) => e !== ".git");
      const included = populated && (opts.includeSubmodule?.(full) ?? false);
      submodules.push({ path: full, populated, included });
      if (included) await scan(join(dir, sub), `${full}/`, false);
    }
  };

  await scan(root, "", true);
  return {
    files: [...new Set(files)].sort(),
    textFiles: [...new Set(textFiles)].sort(),
    escapes: escapes.sort((a, b) => a.path.localeCompare(b.path)),
    submodules: submodules.sort((a, b) => a.path.localeCompare(b.path)),
    via,
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
