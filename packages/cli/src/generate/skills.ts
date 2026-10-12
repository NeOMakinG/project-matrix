import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MatrixConfig } from "@matrix/config";
import type { Files } from "./docs";

/** Repo-level `skills/` directory shipped with the factory (also a Claude Code plugin). */
export const SKILLS_DIR = join(import.meta.dirname, "..", "..", "..", "..", "skills");

/** Skills every factory project gets, whatever the stack. */
const BASE = ["matrix-loop", "matrix", "testing", "security"];

/** Skills an agent working on this project should load, derived from the stack answers. */
export function skillsFor(c: MatrixConfig): string[] {
  const out = new Set(BASE);
  const fe = c.frontend;
  const ui = c.platforms.some((p) => ["web", "ios", "android", "desktop"].includes(p));
  if (ui) out.add("accessibility");
  if (fe?.framework === "react") {
    out.add("react");
    if (fe.bundler === "next") out.add("nextjs");
    if (fe.bundler === "tanstack-start") out.add("tanstack-start");
  }
  if (c.mobile?.framework === "expo") out.add("expo-react-native");
  if (c.desktop?.framework === "tauri") out.add("tauri");
  if (c.backend.kind === "node-api") out.add("node-api");
  if (c.backend.kind === "go") out.add("go");
  return [...out].sort();
}

const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Skills are short markdown; anything bigger is refused rather than copied. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;

/** Copies the chosen skills into `.claude/skills/<name>/` of the generated project. */
export async function skillFiles(names: string[], dir = SKILLS_DIR): Promise<Files> {
  const files: Files = {};
  for (const name of names) {
    if (!SAFE_NAME.test(name)) throw new Error(`invalid skill name: ${name}`);
    const entries = await readdir(join(dir, name), { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const path = join(dir, name, e.name);
      const st = await lstat(path);
      if (!st.isFile() || st.size > MAX_SKILL_FILE_BYTES)
        throw new Error(
          `skill file ${name}/${e.name} is not a regular file under ${MAX_SKILL_FILE_BYTES} bytes`,
        );
      files[`.claude/skills/${name}/${e.name}`] = await readFile(path, "utf8");
    }
    if (!files[`.claude/skills/${name}/SKILL.md`]) throw new Error(`skill ${name} has no SKILL.md`);
  }
  return files;
}
