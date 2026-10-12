import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Writes a throwaway project from a path → content map and returns its root. */
export async function fixtureProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "matrix-fixture-"));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  return root;
}
