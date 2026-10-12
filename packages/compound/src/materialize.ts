import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Candidate } from "./types.js";

export interface MaterializedChange {
  path: string;
  summary: string;
}

const marker = (c: Candidate) => `<!-- matrix-lesson ${c.id} v${c.version} -->`;

async function appendOnce(path: string, block: string, id: string): Promise<boolean> {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current.includes(`<!-- matrix-lesson ${id} `)) return false;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${current && !current.endsWith("\n") ? "\n" : ""}${block}\n`);
  return true;
}

/**
 * Writes a promoted candidate into the files agents read: phase prompts, phase checklists, or ADR rule
 * blocks consumed by `matrix check`. Idempotent per candidate id. Refuses anything not promoted.
 */
export async function materialize(
  root: string,
  candidate: Candidate,
): Promise<MaterializedChange[]> {
  if (candidate.status !== "promoted") {
    throw new Error(
      `${candidate.id} is ${candidate.status}; only promoted candidates are materialized`,
    );
  }
  const p = candidate.payload;
  const changes: MaterializedChange[] = [];
  if (p.kind === "prompt-patch") {
    const path = join(root, ".matrix", "prompts", `${p.phase}.md`);
    if (await appendOnce(path, `${marker(candidate)}\n- ${p.text}`, candidate.id)) {
      changes.push({ path, summary: `prompt patch for ${p.phase}` });
    }
  } else if (p.kind === "checklist-item") {
    const path = join(root, ".matrix", "checklists", `${p.phase}.md`);
    if (await appendOnce(path, `${marker(candidate)}\n- [ ] ${p.item}`, candidate.id)) {
      changes.push({ path, summary: `checklist item for ${p.phase}` });
    }
  } else {
    const path = join(root, ".matrix", "rules", `${candidate.id}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ id: candidate.id, version: candidate.version, ...p.rule }, null, 2)}\n`,
    );
    changes.push({ path, summary: `rule ${p.rule.type}: ${p.rule.pattern}` });
  }
  return changes;
}
