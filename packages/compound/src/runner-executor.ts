import {
  isTrustedHoldout,
  parseFindings,
  type Runner,
  type RunnerId,
  type Workspace,
} from "@matrix/core";
import type { ReplayCase, ReplayExecutor } from "./evaluate.js";
import { similarity } from "./propose.js";
import type { Candidate, Metrics } from "./types.js";

/** The text a candidate adds to a phase prompt when it is applied. ADR rules are surfaced as constraints. */
export function candidateInstruction(candidate: Candidate): string {
  const p = candidate.payload;
  switch (p.kind) {
    case "prompt-patch":
      return p.text;
    case "checklist-item":
      return `Checklist: ${p.item}`;
    case "adr-rule":
      return `Architecture rule${p.rule.adr ? ` (${p.rule.adr})` : ""}: ${p.rule.message}`;
  }
}

/**
 * One-to-one greedy matching of expected P1s to reported P1s (best similarity first). Each reported
 * finding can satisfy at most one expectation; unmatched reports count as false positives.
 */
export function matchFindings(
  expected: string[],
  reported: string[],
  threshold: number,
): { caught: number; falsePositives: number } {
  const pairs: { e: number; r: number; s: number }[] = [];
  expected.forEach((exp, e) =>
    reported.forEach((rep, r) => {
      const s = similarity(exp, rep);
      if (s >= threshold) pairs.push({ e, r, s });
    }),
  );
  pairs.sort((a, b) => b.s - a.s || a.e - b.e || a.r - b.r);
  const usedE = new Set<number>();
  const usedR = new Set<number>();
  for (const p of pairs) {
    if (usedE.has(p.e) || usedR.has(p.r)) continue;
    usedE.add(p.e);
    usedR.add(p.r);
  }
  return { caught: usedE.size, falsePositives: reported.length - usedR.size };
}

export interface RunnerExecutorOptions {
  runner: Runner;
  runnerId: RunnerId;
  model: string;
  projectId: string;
  /** Every replay run gets its own fresh worktree from here, cleaned up afterwards. */
  workspace: Workspace;
  repoPath: string;
  baseBranch: string;
  timeoutMs?: number;
  matchThreshold?: number;
}

/**
 * Replays review-style cases through a Runner. Each execution runs read-only in a fresh worktree, so
 * the baseline and candidate runs cannot see each other's changes.
 */
export function runnerExecutor(opts: RunnerExecutorOptions): ReplayExecutor {
  let seq = 0;
  return {
    id: `runner:${opts.runnerId}:${opts.model}`,
    async execute(replay: ReplayCase, candidate: Candidate | null): Promise<Metrics> {
      seq += 1;
      const variant = candidate ? candidate.id : "baseline";
      const prepared = await opts.workspace.prepare({
        projectId: opts.projectId,
        ticketId: replay.ticketId,
        repoPath: opts.repoPath,
        branch: `matrix/replay/${replay.id.replace(/[^A-Za-z0-9._-]/g, "_")}/${variant}/${seq}`,
        baseBranch: opts.baseBranch,
      });
      try {
        const prompt = candidate
          ? `${replay.input}\n\nAdditional guidance:\n- ${candidateInstruction(candidate)}`
          : replay.input;
        const result = await opts.runner.run(
          {
            runId: `replay-${replay.id}-${variant}-${seq}`,
            projectId: opts.projectId,
            ticketId: replay.ticketId,
            phase: replay.phase,
            runner: opts.runnerId,
            model: opts.model,
            prompt,
            workdir: prepared.workdir,
            readOnly: true,
            timeoutMs: opts.timeoutMs ?? 300_000,
          },
          () => {},
          new AbortController().signal,
        );
        let parsed = true;
        let findings: ReturnType<typeof parseFindings> = [];
        try {
          findings = parseFindings(result.summary);
        } catch {
          parsed = false;
        }
        const p1 = findings.filter((f) => f.severity === "P1");
        const threshold = opts.matchThreshold ?? 0.34;
        const { caught, falsePositives } = matchFindings(
          replay.expectedP1,
          p1.map((f) => `${f.title} ${f.detail ?? ""}`),
          threshold,
        );
        // Only holdout scores produced by core's judge count; runner-supplied receipts are ignored.
        const holdout = result.receipts.find(isTrustedHoldout)?.data as
          | { satisfaction?: number }
          | undefined;
        return {
          loopbacks: result.status === "ok" && parsed ? 0 : 1,
          p1Caught: caught,
          p1Expected: replay.expectedP1.length,
          p1FalsePositives: falsePositives,
          holdoutSatisfaction: typeof holdout?.satisfaction === "number" ? holdout.satisfaction : 1,
          costUsd: result.costUsd ?? 0,
        };
      } finally {
        await opts.workspace.cleanup(prepared);
      }
    },
  };
}
