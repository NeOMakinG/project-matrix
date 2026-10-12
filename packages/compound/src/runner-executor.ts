import { type Phase, parseFindings, type Runner, type RunnerId } from "@matrix/core";
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

export interface RunnerExecutorOptions {
  runner: Runner;
  runnerId: RunnerId;
  model: string;
  workdir: string;
  projectId: string;
  timeoutMs?: number;
  matchThreshold?: number;
}

/** Replays review-style cases through a real (or fake) Runner and scores the P1s it reports. */
export function runnerExecutor(opts: RunnerExecutorOptions): ReplayExecutor {
  let seq = 0;
  return {
    async execute(replay: ReplayCase, candidate: Candidate | null): Promise<Metrics> {
      seq += 1;
      const prompt = candidate
        ? `${replay.input}\n\nAdditional guidance:\n- ${candidateInstruction(candidate)}`
        : replay.input;
      const controller = new AbortController();
      const result = await opts.runner.run(
        {
          runId: `replay-${replay.id}-${candidate ? candidate.id : "baseline"}-${seq}`,
          projectId: opts.projectId,
          ticketId: replay.ticketId,
          phase: replay.phase as Phase,
          runner: opts.runnerId,
          model: opts.model,
          prompt,
          workdir: opts.workdir,
          timeoutMs: opts.timeoutMs ?? 300_000,
        },
        () => {},
        controller.signal,
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
      const caught = replay.expectedP1.filter((exp) =>
        p1.some((f) => similarity(exp, `${f.title} ${f.detail ?? ""}`) >= threshold),
      ).length;
      const holdout = result.receipts.find((r) => r.kind === "holdout")?.data as
        | { satisfaction?: number }
        | undefined;
      return {
        loopbacks: result.status === "ok" && parsed ? 0 : 1,
        p1Caught: caught,
        p1Expected: replay.expectedP1.length,
        holdoutSatisfaction: holdout?.satisfaction ?? (result.status === "ok" ? 1 : 0),
        costUsd: result.costUsd ?? 0,
      };
    },
  };
}
