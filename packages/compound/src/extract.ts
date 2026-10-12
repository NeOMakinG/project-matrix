import { findingsOf, type Phase, type Receipt, type RunRecord, type Store } from "@matrix/core";
import type { RawLesson } from "./types.js";
import { PhaseSchema } from "./types.js";

export interface HumanComment {
  ticketId: string;
  phase?: Phase;
  text: string;
  file?: string;
}

const GATE_PHASES = new Set(["checks", "review", "qa"]);

function failing(receipts: Receipt[]): Receipt[] {
  return receipts.filter((r) => !r.ok && r.kind !== "review");
}

/**
 * Turns one ticket's run history into raw lessons. Deterministic: runs are processed in start order
 * and duplicates (same source + text) are collapsed.
 */
export async function extractLessons(
  store: Store,
  projectId: string,
  ticketId: string,
  humanComments: HumanComment[] = [],
): Promise<RawLesson[]> {
  const runs = (await store.listRuns({ projectId, ticketId })).sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id),
  );
  const receiptsByRun = new Map<string, Receipt[]>();
  for (const run of runs) receiptsByRun.set(run.id, await store.listReceipts(run.id));

  const out: RawLesson[] = [];
  const push = (lesson: RawLesson) => {
    if (!out.some((l) => l.source === lesson.source && l.text === lesson.text)) out.push(lesson);
  };

  runs.forEach((run: RunRecord, index) => {
    const receipts = receiptsByRun.get(run.id) ?? [];
    if (run.phase === "review") {
      for (const f of receipts.flatMap(findingsOf)) {
        push({
          projectId,
          ticketId,
          source: "review-finding",
          phase: "review",
          text: f.title,
          severity: f.severity,
          ...(f.file ? { file: f.file } : {}),
          runId: run.id,
        });
      }
    }
    if (run.phase === "qa") {
      for (const r of failing(receipts)) {
        push({
          projectId,
          ticketId,
          source: "qa-failure",
          phase: "qa",
          text: r.summary,
          runId: run.id,
        });
      }
    }
    if (GATE_PHASES.has(run.phase)) {
      const failed = run.status !== "ok" || receipts.some((r) => !r.ok);
      const loopedBack = runs.slice(index + 1).some((later) => later.phase === "implement");
      if (failed && loopedBack) {
        const reasons = receipts.filter((r) => !r.ok).map((r) => r.summary);
        push({
          projectId,
          ticketId,
          source: "loopback",
          phase: run.phase,
          text: reasons.length ? reasons.join("; ") : (run.summary ?? `${run.phase} ${run.status}`),
          runId: run.id,
        });
      }
    }
  });

  for (const c of humanComments.filter((c) => c.ticketId === ticketId)) {
    push({
      projectId,
      ticketId,
      source: "human-comment",
      phase: PhaseSchema.catch("review").parse(c.phase ?? "review"),
      text: c.text,
      ...(c.file ? { file: c.file } : {}),
    });
  }
  return out;
}
