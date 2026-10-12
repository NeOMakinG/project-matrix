import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { SOURCE_EXTENSIONS } from "./files";
import { isRelative } from "./imports";

interface WorkspacePackage {
  name: string;
  dir: string;
  entry?: string;
}

interface PathsConfig {
  /** Directory of the tsconfig (repo-relative, "" for root). */
  dir: string;
  baseUrl: string;
  paths: Record<string, string[]>;
}

/** Resolves module specifiers to repo files: relative paths, workspace packages, tsconfig paths. */
export interface Resolver {
  resolve(from: string, specifier: string): string | undefined;
}

/** Matches a tsconfig `paths` key (one `*` wildcard); returns the captured part. */
export function matchPathPattern(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  if (specifier.length < prefix.length + suffix.length) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

const stripJs = (p: string) => p.replace(/\.(m|c)?jsx?$/, "");

function candidates(base: string): string[] {
  const stem = stripJs(base);
  return [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => `${stem}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
}

const firstKnown = (paths: string[], known: ReadonlySet<string>) => paths.find((c) => known.has(c));

/** Reads a repo-relative file, or undefined when it doesn't exist. */
export type ReadText = (rel: string) => Promise<string | undefined>;

export const diskReader =
  (root: string): ReadText =>
  (rel) =>
    readFile(join(root, rel), "utf8").catch(() => undefined);

async function readJson(read: ReadText, rel: string): Promise<Record<string, unknown> | undefined> {
  const text = await read(rel);
  if (!text) return undefined;
  try {
    // tsconfig allows comments and trailing commas.
    return JSON.parse(
      text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1"),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const entryOf = (pkg: Record<string, unknown>): string | undefined => {
  const exp = pkg.exports;
  if (typeof exp === "string") return exp;
  if (exp && typeof exp === "object") {
    const dot = (exp as Record<string, unknown>)["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") {
      for (const k of ["import", "default", "types"]) {
        const v = (dot as Record<string, unknown>)[k];
        if (typeof v === "string") return v;
      }
    }
  }
  for (const k of ["module", "main", "types"])
    if (typeof pkg[k] === "string") return pkg[k] as string;
  return undefined;
};

/**
 * Builds a resolver for the project at `root` from its file list: every `package.json` among the
 * repo's files is a workspace package, and every `tsconfig*.json` contributes `paths` aliases for
 * files under its folder (following one `extends` level).
 */
export async function createResolver(
  root: string,
  files: string[],
  read: ReadText = diskReader(root),
): Promise<Resolver> {
  const known = new Set(files);
  const packages: WorkspacePackage[] = [];
  const pathsConfigs: PathsConfig[] = [];
  const allFiles = await listConfigFiles(read, files);

  for (const rel of allFiles.packages) {
    const pkg = await readJson(read, rel);
    if (!pkg || typeof pkg.name !== "string") continue;
    const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
    const entry = entryOf(pkg);
    packages.push({ name: pkg.name, dir, ...(entry ? { entry } : {}) });
  }

  for (const rel of allFiles.tsconfigs) {
    const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
    let cfg = await readJson(read, rel);
    let opts = (cfg?.compilerOptions ?? {}) as Record<string, unknown>;
    let cfgDir = dir;
    if (!opts.paths && typeof cfg?.extends === "string" && isRelative(cfg.extends)) {
      const parentRel = posix.normalize(posix.join(dir, cfg.extends));
      const parentPath = parentRel.endsWith(".json") ? parentRel : `${parentRel}.json`;
      cfg = await readJson(read, parentPath);
      opts = (cfg?.compilerOptions ?? {}) as Record<string, unknown>;
      cfgDir = posix.dirname(parentPath) === "." ? "" : posix.dirname(parentPath);
    }
    if (opts.paths && typeof opts.paths === "object") {
      pathsConfigs.push({
        dir,
        baseUrl: posix.normalize(
          posix.join(cfgDir, typeof opts.baseUrl === "string" ? opts.baseUrl : "."),
        ),
        paths: opts.paths as Record<string, string[]>,
      });
    }
  }
  // Longest folder first, so the nearest tsconfig wins.
  pathsConfigs.sort((a, b) => b.dir.length - a.dir.length);
  packages.sort((a, b) => b.name.length - a.name.length);

  const inDir = (file: string, dir: string) => dir === "" || file.startsWith(`${dir}/`);

  return {
    resolve(from, specifier) {
      if (isRelative(specifier))
        return firstKnown(
          candidates(posix.normalize(posix.join(posix.dirname(from), specifier))),
          known,
        );

      for (const cfg of pathsConfigs) {
        if (!inDir(from, cfg.dir)) continue;
        for (const [pattern, targets] of Object.entries(cfg.paths)) {
          const star = matchPathPattern(pattern, specifier);
          if (star === undefined) continue;
          for (const t of targets) {
            const target = posix.normalize(posix.join(cfg.baseUrl, t.replace("*", star)));
            const hit = firstKnown(candidates(target), known);
            if (hit) return hit;
          }
        }
        break;
      }

      for (const p of packages) {
        if (specifier !== p.name && !specifier.startsWith(`${p.name}/`)) continue;
        const sub = specifier.slice(p.name.length).replace(/^\//, "");
        const base = (x: string) => posix.normalize(posix.join(p.dir, x));
        if (sub) return firstKnown(candidates(base(sub)), known);
        const entries = [
          ...(p.entry ? candidates(base(p.entry)) : []),
          ...candidates(base("src/index")),
          ...candidates(base("index")),
        ];
        return firstKnown(entries, known);
      }
      return undefined;
    },
  };
}

async function listConfigFiles(
  read: ReadText,
  sourceFiles: string[],
): Promise<{ packages: string[]; tsconfigs: string[] }> {
  const dirs = new Set([""]);
  for (const f of sourceFiles) {
    let d = posix.dirname(f);
    while (d !== "." && !dirs.has(d)) {
      dirs.add(d);
      d = posix.dirname(d);
    }
  }
  const packages: string[] = [];
  const tsconfigs: string[] = [];
  for (const d of dirs) {
    const pkg = d ? `${d}/package.json` : "package.json";
    if ((await read(pkg)) !== undefined) packages.push(pkg);
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const ts = d ? `${d}/${name}` : name;
      if ((await read(ts)) !== undefined) tsconfigs.push(ts);
    }
  }
  return { packages: packages.sort(), tsconfigs: tsconfigs.sort() };
}
