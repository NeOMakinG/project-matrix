import type { Phase } from "@matrix/core";
import type { ReplayCase } from "./evaluate.js";
import { sha256 } from "./hash.js";

export interface SampleOptions {
  /** Cases per phase (strata). Phases with fewer cases contribute all of theirs. */
  perPhase: number;
  /** Only these phases; default: every phase present in history. */
  phases?: Phase[];
  /** Total cap after stratification. */
  max?: number;
  /** Deterministic seed; same history + seed gives the same sample. */
  seed: string;
  /** Cases to leave out (e.g. the tickets that produced the candidate's evidence). */
  excludeTickets?: string[];
}

/**
 * Stratified, deterministic sample of replay cases from history. Duplicates (same id, or same phase +
 * input + expectations) are dropped first, so a case can't be counted twice.
 */
export function sampleCases(history: ReplayCase[], opts: SampleOptions): ReplayCase[] {
  const exclude = new Set(opts.excludeTickets ?? []);
  const byId = new Set<string>();
  const byContent = new Set<string>();
  const unique: ReplayCase[] = [];
  for (const c of [...history].sort((a, b) => a.id.localeCompare(b.id))) {
    if (exclude.has(c.ticketId)) continue;
    const content = sha256(JSON.stringify([c.phase, c.input, [...c.expectedP1].sort()]));
    if (byId.has(c.id) || byContent.has(content)) continue;
    byId.add(c.id);
    byContent.add(content);
    unique.push(c);
  }
  const phases = opts.phases ?? [...new Set(unique.map((c) => c.phase))].sort();
  const picked: ReplayCase[] = [];
  for (const phase of phases) {
    const stratum = unique
      .filter((c) => c.phase === phase)
      .map((c) => ({ c, key: sha256(`${opts.seed}\u0000${c.id}`) }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, opts.perPhase)
      .map((x) => x.c);
    picked.push(...stratum);
  }
  return picked.slice(0, opts.max ?? picked.length).sort((a, b) => a.id.localeCompare(b.id));
}
