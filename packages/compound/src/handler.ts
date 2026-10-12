import type { PhaseHandler, Store } from "@matrix/core";
import { extractLessons, type HumanComment } from "./extract.js";
import { LessonStore } from "./lesson-store.js";
import { type Proposer, proposeCandidates } from "./propose.js";

export interface CompoundDeps {
  store: Store;
  proposer?: Proposer;
  humanComments?: (projectId: string, ticketId: string) => Promise<HumanComment[]>;
  now?: () => Date;
}

/**
 * Drop-in replacement for core's `compound` phase handler. It records lessons and proposes versioned
 * candidates, but never promotes: promotion needs a recorded replay evaluation (see `evaluateCandidate`).
 */
export function createCompoundHandler(deps: CompoundDeps): PhaseHandler {
  return async (ctx) => {
    const comments = (await deps.humanComments?.(ctx.project.id, ctx.ticket.id)) ?? [];
    const lessons = await extractLessons(deps.store, ctx.project.id, ctx.ticket.id, comments);
    const proposals = await proposeCandidates(
      lessons,
      deps.proposer ? { proposer: deps.proposer } : {},
    );
    const store = new LessonStore(ctx.project.repoPath, deps.store, deps.now);
    const ids: string[] = [];
    for (const proposal of proposals) {
      const candidate = await store.upsert(ctx.project.id, proposal);
      ids.push(`${candidate.id}@v${candidate.version}`);
    }
    ctx.emit(`compound: ${lessons.length} lessons, ${ids.length} candidates`, "log", { ids });
    return {
      ok: true,
      summary: `recorded ${lessons.length} lessons into ${ids.length} candidates (not promoted)`,
      receipts: [
        {
          kind: "log",
          ok: true,
          summary: `compound candidates: ${ids.join(", ") || "none"}`,
          data: { lessons: lessons.length, candidates: ids },
        },
      ],
    };
  };
}
