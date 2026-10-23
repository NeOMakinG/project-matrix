import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { CheckCommand } from "@matrix/core";
import type { SetupStep } from "./existing-repo.js";

/**
 * Package registries dependency setup may reach through the egress proxy (HTTPS CONNECT, port 443
 * only). Git or tarball dependencies hosted anywhere else fail closed: set explicit setup steps and
 * vendor them, or extend this list in code after review.
 */
export const REGISTRY_HOSTS = ["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com"];

/** Lockfile → frozen install argv, in detection priority order. */
const INSTALLERS: Array<[lockfile: string, argv: string[]]> = [
  ["bun.lock", ["bun", "install", "--frozen-lockfile"]],
  ["bun.lockb", ["bun", "install", "--frozen-lockfile"]],
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
  ["package-lock.json", ["npm", "ci", "--no-audit", "--no-fund"]],
];
export const LOCKFILES = INSTALLERS.map(([file]) => file);

const DIR = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const DIR_FLAGS = new Set(["--prefix", "-C", "--cwd", "--dir"]);

/** Directories check commands run in: `npm --prefix app`, `pnpm -C app`, `yarn --cwd app`. */
export function checkDirs(checks: readonly CheckCommand[]): string[] {
  const dirs = new Set<string>();
  for (const { cmd } of checks)
    cmd.forEach((arg, index) => {
      const eq = arg.indexOf("=");
      const value =
        DIR_FLAGS.has(arg) && index > 0
          ? cmd[index + 1]
          : eq > 0 && DIR_FLAGS.has(arg.slice(0, eq))
            ? arg.slice(eq + 1)
            : undefined;
      const dir = value?.replace(/^\.\//, "").replace(/\/+$/, "");
      if (dir && dir !== "." && DIR.test(dir) && !dir.split("/").includes("..")) dirs.add(dir);
    });
  return [...dirs];
}

/** A regular file reached through real directories only (no symlink anywhere on the way). */
export async function realFile(workdir: string, rel: string): Promise<boolean> {
  const segments = rel.split("/");
  for (let index = 1; index <= segments.length; index++) {
    const stat = await lstat(join(workdir, ...segments.slice(0, index))).catch(() => undefined);
    if (!stat || stat.isSymbolicLink()) return false;
    if (index < segments.length ? !stat.isDirectory() : !stat.isFile()) return false;
  }
  return true;
}

/**
 * Default setup when the operator set none: one frozen install per directory (the root first,
 * then every directory a check runs in) that has a `package.json` and a lockfile. Lifecycle
 * scripts are off (`--ignore-scripts`) unless the project opted in.
 */
export async function detectSetup(
  workdir: string,
  checks: readonly CheckCommand[],
  scripts = false,
): Promise<SetupStep[]> {
  const steps: SetupStep[] = [];
  for (const dir of [".", ...checkDirs(checks)]) {
    const at = (file: string) => (dir === "." ? file : `${dir}/${file}`);
    if (!(await realFile(workdir, at("package.json")))) continue;
    for (const [lockfile, argv] of INSTALLERS) {
      if (!(await realFile(workdir, at(lockfile)))) continue;
      steps.push({
        ...(dir === "." ? {} : { cwd: dir }),
        run: scripts ? [...argv] : [...argv, "--ignore-scripts"],
      });
      break;
    }
  }
  return steps;
}
