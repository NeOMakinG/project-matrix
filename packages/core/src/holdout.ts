import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Receipt } from "./ports.js";

export interface HoldoutScenario {
  id: string;
  given: string;
  when: string;
  then: string;
}

export interface ScenarioVerdict {
  id: string;
  satisfied: boolean;
  reason: string;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** Only holdout receipts produced by core's own judge carry this tag; drivers' receipts are dropped. */
export const HOLDOUT_PROVENANCE = "core-judge";

export function isTrustedHoldout(receipt: Receipt): boolean {
  return (
    receipt.kind === "holdout" &&
    (receipt.data as { provenance?: string } | undefined)?.provenance === HOLDOUT_PROVENANCE
  );
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error("no JSON found in model output");
  const open = candidate[start];
  const close = open === "[" ? "]" : "}";
  const end = candidate.lastIndexOf(close);
  if (end <= start) throw new Error("unterminated JSON in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

export function parseScenarios(text: string): HoldoutScenario[] {
  const value = extractJson(text);
  const list = Array.isArray(value) ? value : (value as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(list)) throw new Error("scenarios must be an array");
  return list.map((raw, i) => {
    const s = raw as Partial<HoldoutScenario>;
    if (!s.given || !s.when || !s.then) throw new Error(`scenario ${i} is missing given/when/then`);
    return {
      id: s.id && SAFE_ID.test(s.id) ? s.id : `s${i + 1}`,
      given: s.given,
      when: s.when,
      then: s.then,
    };
  });
}

export function parseVerdicts(text: string): ScenarioVerdict[] {
  const value = extractJson(text);
  const list = Array.isArray(value) ? value : (value as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(list)) throw new Error("verdicts must be an array");
  return list.map((raw) => {
    const v = raw as Partial<ScenarioVerdict>;
    if (typeof v.id !== "string" || typeof v.satisfied !== "boolean")
      throw new Error("invalid verdict");
    return { id: v.id, satisfied: v.satisfied, reason: v.reason ?? "" };
  });
}

export function holdoutReceipt(
  scenarios: HoldoutScenario[],
  verdicts: ScenarioVerdict[],
  judgeModel: string,
): Receipt {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const satisfied = scenarios.filter((s) => byId.get(s.id)?.satisfied === true).length;
  const satisfaction = scenarios.length ? satisfied / scenarios.length : 0;
  return {
    kind: "holdout",
    ok: scenarios.length > 0,
    summary: `${satisfied}/${scenarios.length} holdout scenarios satisfied (judge ${judgeModel})`,
    data: {
      provenance: HOLDOUT_PROVENANCE,
      satisfaction,
      satisfied,
      total: scenarios.length,
      judgeModel,
      verdicts,
    },
  };
}

/** Scenarios live outside every worktree so the implementing agent can never read or edit them. */
export class HoldoutStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private file(projectId: string, ticketId: string): string {
    if (!SAFE_ID.test(projectId) || !SAFE_ID.test(ticketId)) {
      throw new Error("unsafe project or ticket id for holdout path");
    }
    return join(this.root, projectId, `${ticketId}.json`);
  }

  /** True when `path` is the store root or below it ("/data/holdouts-evil" is not inside "/data/holdouts"). */
  isInside(path: string): boolean {
    const rel = relative(this.root, resolve(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  /** Refuses to operate when the store would sit inside a worktree the implementer can read. */
  assertOutside(workdir: string): void {
    const rel = relative(resolve(workdir), this.root);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new Error("holdout store must live outside the worktree");
    }
  }

  async save(projectId: string, ticketId: string, scenarios: HoldoutScenario[]): Promise<void> {
    const file = this.file(projectId, ticketId);
    await mkdir(join(this.root, projectId), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(scenarios, null, 2), { mode: 0o600 });
  }

  async load(projectId: string, ticketId: string): Promise<HoldoutScenario[]> {
    try {
      return JSON.parse(
        await readFile(this.file(projectId, ticketId), "utf8"),
      ) as HoldoutScenario[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
