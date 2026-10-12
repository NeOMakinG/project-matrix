import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { type Adr, DEFAULT_ADR_DIR, isActive, parseAdr } from "./adr";

/** Records how many enforceable ADR rules a project must have. Written by `matrix init`. */
export const RULES_MANIFEST_PATH = ".matrix/rules-manifest.json";

export interface RulesManifest {
  version: 1;
  adrDir: string;
  /** Minimum number of enforced rules; fewer loaded rules fails the check. */
  minRules: number;
}

/** Where rules were loaded from. `git` means a base commit, not the code under check. */
export type RulesSource = { kind: "worktree" } | { kind: "git"; ref: string; commit: string };

export interface LoadedRules {
  adrs: Adr[];
  manifest?: RulesManifest;
  source: RulesSource;
  /** Raw ADR files by path, to compare base and working tree. */
  files: Map<string, string>;
}

const git = (root: string, args: string[]) =>
  spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const ADR_FILE = /^\d{4}-[\w.-]+\.md$/;

function parseManifest(text: string | undefined): RulesManifest | undefined {
  if (!text) return undefined;
  try {
    const m = JSON.parse(text) as RulesManifest;
    return m.version === 1 && typeof m.minRules === "number" ? m : undefined;
  } catch {
    return undefined;
  }
}

function toAdrs(files: Map<string, string>): Adr[] {
  const adrs: Adr[] = [];
  for (const [path, text] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const adr = parseAdr(path, text);
    if (adr) adrs.push(adr);
  }
  return adrs;
}

/** Rules from the working tree (local runs). */
export async function loadWorktreeRules(
  root: string,
  adrDir = DEFAULT_ADR_DIR,
): Promise<LoadedRules> {
  const files = new Map<string, string>();
  for (const name of (await readdir(join(root, adrDir)).catch(() => [] as string[])).sort()) {
    if (ADR_FILE.test(name))
      files.set(posix.join(adrDir, name), await readFile(join(root, adrDir, name), "utf8"));
  }
  const manifest = parseManifest(
    await readFile(join(root, RULES_MANIFEST_PATH), "utf8").catch(() => undefined),
  );
  return {
    adrs: toAdrs(files),
    ...(manifest ? { manifest } : {}),
    source: { kind: "worktree" },
    files,
  };
}

/**
 * Resolves the commit rules are loaded from: the merge-base of HEAD and `ref`, so a branch
 * cannot rewrite the rules it is checked against. `base` means the main branch.
 */
export function resolveRulesCommit(root: string, ref: string): string {
  const refs = ref === "base" ? ["origin/main", "main", "origin/master", "master"] : [ref];
  for (const r of refs) {
    const mb = git(root, ["merge-base", "HEAD", r]);
    if (mb.status === 0 && mb.stdout.trim()) return mb.stdout.trim();
    const direct = git(root, ["rev-parse", "--verify", `${r}^{commit}`]);
    if (direct.status === 0 && direct.stdout.trim()) return direct.stdout.trim();
  }
  throw new Error(`cannot resolve rules ref "${ref}" (fetch the base branch, e.g. fetch-depth: 0)`);
}

/** Rules as they were at a git commit (paths relative to `root`). */
export function loadRulesAt(root: string, ref: string, adrDir = DEFAULT_ADR_DIR): LoadedRules {
  const commit = resolveRulesCommit(root, ref);
  const ls = git(root, ["ls-tree", "--name-only", commit, "--", `${adrDir}/`]);
  if (ls.status !== 0) throw new Error(`git ls-tree failed: ${ls.stderr.trim()}`);
  const files = new Map<string, string>();
  for (const line of ls.stdout.split("\n").filter(Boolean)) {
    const name = posix.basename(line);
    if (!ADR_FILE.test(name)) continue;
    const path = posix.join(adrDir, name);
    const show = git(root, ["show", `${commit}:./${path}`]);
    if (show.status === 0) files.set(path, show.stdout);
  }
  const m = git(root, ["show", `${commit}:./${RULES_MANIFEST_PATH}`]);
  const manifest = parseManifest(m.status === 0 ? m.stdout : undefined);
  return {
    adrs: toAdrs(files),
    ...(manifest ? { manifest } : {}),
    source: { kind: "git", ref, commit },
    files,
  };
}

export interface AdrChange {
  file: string;
  change: "added" | "removed" | "modified";
}

/** ADR files changed between the rules source and the working tree. These need human review. */
export function diffAdrs(base: Map<string, string>, head: Map<string, string>): AdrChange[] {
  const out: AdrChange[] = [];
  for (const [file, text] of head) {
    if (!base.has(file)) out.push({ file, change: "added" });
    else if (base.get(file) !== text) out.push({ file, change: "modified" });
  }
  for (const file of base.keys()) if (!head.has(file)) out.push({ file, change: "removed" });
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export const countEnforced = (adrs: Adr[]) =>
  adrs.filter(isActive).reduce((n, a) => n + a.rules.filter((r) => r.rule.check).length, 0);
