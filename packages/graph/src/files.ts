import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import picomatch from "picomatch";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".matrix",
  ".turbo",
  ".next",
  ".output",
  ".vite",
]);

/** Repo-relative POSIX path. */
export const toPosix = (p: string) => p.split(sep).join("/");

export const isSource = (path: string) => SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));

export const isDeclaration = (path: string) => /\.d\.[cm]?ts$/.test(path);

/** Lists source files under `root`, sorted, as repo-relative POSIX paths. */
export async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(join(dir, e.name));
      } else if (e.isFile() && isSource(e.name) && !isDeclaration(e.name)) {
        out.push(toPosix(relative(root, join(dir, e.name))));
      }
    }
  }
  await walk(root);
  return out.sort();
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
