import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AutonomyMode } from "@matrix/core";
import type { EvalPolicy } from "./evaluate.js";
import type { EvalLedger } from "./ledger.js";
import { assertNoSymlink, safeJoin } from "./paths.js";
import { assertApplicable } from "./promote.js";
import type { Candidate } from "./types.js";

export interface MaterializedChange {
  path: string;
  summary: string;
}

const marker = (c: Candidate) => `<!-- matrix-lesson ${c.id} v${c.version} -->`;

async function appendOnce(root: string, path: string, block: string, id: string): Promise<boolean> {
  await assertNoSymlink(root, path);
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
 * Writes a candidate into the files agents read. Re-verifies everything against the ledger first
 * (promotion of this exact patch, its evaluation, approval for the project's autonomy mode); the
 * candidate file's own `status` is ignored. Paths come from enums and validated ids only.
 */
export async function materialize(
  root: string,
  candidate: Candidate,
  ledger: EvalLedger,
  mode: AutonomyMode,
  policy?: EvalPolicy,
): Promise<MaterializedChange[]> {
  await assertApplicable(candidate, ledger, mode, policy);
  const p = candidate.payload;
  if (p.kind === "prompt-patch") {
    const path = safeJoin(root, ".matrix", "prompts", `${p.phase}.md`);
    return (await appendOnce(root, path, `${marker(candidate)}\n- ${p.text}`, candidate.id))
      ? [{ path, summary: `prompt patch for ${p.phase}` }]
      : [];
  }
  if (p.kind === "checklist-item") {
    const path = safeJoin(root, ".matrix", "checklists", `${p.phase}.md`);
    return (await appendOnce(root, path, `${marker(candidate)}\n- [ ] ${p.item}`, candidate.id))
      ? [{ path, summary: `checklist item for ${p.phase}` }]
      : [];
  }
  const path = safeJoin(root, ".matrix", "rules", `${candidate.id}.json`);
  await mkdir(dirname(path), { recursive: true });
  await assertNoSymlink(root, path);
  await writeFile(
    path,
    `${JSON.stringify({ id: candidate.id, version: candidate.version, ...p.rule }, null, 2)}\n`,
  );
  return [{ path, summary: `rule ${p.rule.type}: ${p.rule.pattern}` }];
}
