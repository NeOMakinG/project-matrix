import type { CandidatePayload, RawLesson } from "./types.js";

export interface Proposal {
  title: string;
  payload: CandidatePayload;
  evidence: RawLesson[];
}

/** Optional model-backed proposer; the deterministic heuristic is used when absent or when it fails validation. */
export interface Proposer {
  propose(cluster: RawLesson[]): Promise<Proposal | null>;
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "to",
  "for",
  "is",
  "and",
  "or",
  "with",
  "missing",
  "not",
]);

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_./-]+/g, " ")
      .split(" ")
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/** Groups similar lessons; order-independent output (clusters sorted by size, then first text). */
export function cluster(lessons: RawLesson[], threshold = 0.4): RawLesson[][] {
  const sorted = [...lessons].sort((a, b) => a.text.localeCompare(b.text));
  const groups: RawLesson[][] = [];
  for (const lesson of sorted) {
    const group = groups.find((g) => g.some((l) => similarity(l.text, lesson.text) >= threshold));
    if (group) group.push(lesson);
    else groups.push([lesson]);
  }
  return groups.sort((a, b) => b.length - a.length || a[0]!.text.localeCompare(b[0]!.text));
}

const IMPORT_HINT = /\b(import|imports|depend|dependency)\b.*?`?([@\w./-]+)`?/i;

/** Heuristic: structural findings become ADR rules, review/QA gaps become checklist items, loopbacks become prompt patches. */
export function heuristicProposal(group: RawLesson[]): Proposal {
  const head = group[0]!;
  const title = head.text.length > 90 ? `${head.text.slice(0, 87)}...` : head.text;
  const files = [
    ...new Set(group.map((l) => l.file).filter((f): f is string => Boolean(f))),
  ].sort();
  const importMatch = group.map((l) => IMPORT_HINT.exec(l.text)).find(Boolean);

  if (importMatch && head.source === "review-finding") {
    return {
      title,
      evidence: group,
      payload: {
        kind: "adr-rule",
        rule: {
          type: "forbidden-import",
          pattern: importMatch[2]!,
          paths: files.map((f) => f.replace(/[^/]+$/, "**")),
          message: head.text,
        },
      },
    };
  }
  if (head.source === "loopback") {
    return {
      title,
      evidence: group,
      payload: {
        kind: "prompt-patch",
        phase: "implement",
        text: `Before finishing, make sure this does not happen again: ${head.text}`,
      },
    };
  }
  return {
    title,
    evidence: group,
    payload: {
      kind: "checklist-item",
      phase: head.source === "qa-failure" ? "qa" : "review",
      item: head.text,
    },
  };
}

export async function proposeCandidates(
  lessons: RawLesson[],
  opts: { proposer?: Proposer; minEvidence?: number } = {},
): Promise<Proposal[]> {
  const min = opts.minEvidence ?? 1;
  const out: Proposal[] = [];
  for (const group of cluster(lessons)) {
    if (group.length < min) continue;
    let proposal: Proposal | null = null;
    if (opts.proposer) {
      try {
        proposal = await opts.proposer.propose(group);
      } catch {
        proposal = null;
      }
    }
    out.push(proposal ?? heuristicProposal(group));
  }
  return out;
}
