import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { assertSafePath } from "@matrix/tickets/adapters/safe-fs";

export async function trackedArtifactFiles(directory: string): Promise<Record<string, string>> {
  const root = await realpath(directory);
  const listed = spawnSync("git", ["ls-files", "--cached", "-z", "--"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (listed.status !== 0) return {};
  const files: Record<string, string> = Object.create(null);
  for (const path of listed.stdout.split("\0").filter(Boolean)) {
    if (
      !/(^|\/)(package\.json|next\.config\.(js|cjs|mjs|ts)|ios\/Podfile|android\/app\/build\.gradle(?:\.kts)?)$/.test(
        path,
      )
    )
      continue;
    if (
      /[\\\x00-\x1f\x7f*?!\[\]{}:]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      continue;
    try {
      const full = join(root, path);
      await assertSafePath(root, full);
      const stat = await lstat(full);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) continue;
      files[path] = path.endsWith("package.json") ? await readFile(full, "utf8") : "";
    } catch {}
  }
  return files;
}
