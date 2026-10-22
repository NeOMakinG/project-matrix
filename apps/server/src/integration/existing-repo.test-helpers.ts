import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).toString();

/** A real repo with one commit on `main` and an `origin` remote. */
export function makeRepo(root: string, name: string, files: Record<string, string> = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [file, content] of Object.entries({ "README.md": "hi\n", ...files }))
    writeFileSync(join(dir, file), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  git(dir, "remote", "add", "origin", "git@github.com:acme/wayline.git");
  return dir;
}
