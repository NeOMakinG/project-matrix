import { HoldoutStore, holdoutReceipt, parseScenarios, parseVerdicts } from "./holdout.js";
import { autonomyFor, findingsOf } from "./machine.js";
import type { Phase, Receipt, Runner, RunnerId, RunResult, Sandbox } from "./ports.js";
import type {
  DeployPort,
  MergePort,
  PhaseContext,
  QaDriver,
  VerifyPort,
} from "./ports-internal.js";
import { lanePrompt, parseFindings, pickReviewer, reviewReceipt } from "./review.js";
import type { Store } from "./store.js";
import type { PhaseModel, PhaseOutcome } from "./types.js";

export type PhaseHandler = (ctx: PhaseContext) => Promise<PhaseOutcome>;
export type PhaseHandlers = Record<Phase, PhaseHandler>;

export interface HandlerDeps {
  runners: Partial<Record<RunnerId, Runner>>;
  sandbox?: Sandbox;
  holdout: HoldoutStore;
  store: Store;
  qa?: QaDriver;
  merge?: MergePort;
  deploy?: DeployPort;
  verify?: VerifyPort;
}

function tail(text: string, lines = 20): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

export async function callModel(
  deps: HandlerDeps,
  ctx: PhaseContext,
  model: PhaseModel,
  prompt: string,
  phase: Phase = ctx.workflow.phase,
): Promise<RunResult> {
  const runner = deps.runners[model.runner];
  if (!runner) throw new Error(`runner ${model.runner} is not configured`);
  return runner.run(
    {
      runId: ctx.runId,
      projectId: ctx.project.id,
      ticketId: ctx.ticket.id,
      phase,
      runner: model.runner,
      model: model.model,
      prompt,
      workdir: ctx.workdir,
      timeoutMs: ctx.project.runTimeoutMs,
    },
    (event) => ctx.emit(event.message, event.kind, event.data),
    ctx.signal,
  );
}

function outcomeFrom(result: RunResult, model: PhaseModel, extra: Receipt[] = []): PhaseOutcome {
  return {
    ok: result.status === "ok",
    summary: result.summary,
    receipts: [...result.receipts, ...extra],
    runStatus: result.status,
    model: model.model,
    runner: model.runner,
    ...(result.tokens ? { tokens: result.tokens } : {}),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
  };
}

function modelFor(ctx: PhaseContext, phase: Phase): PhaseModel {
  return ctx.project.models[phase] ?? ctx.project.models.implement;
}

const spike =
  (deps: HandlerDeps): PhaseHandler =>
  async (ctx) => {
    const model = modelFor(ctx, "spike");
    const plan = await callModel(
      deps,
      ctx,
      model,
      [
        "Plan this ticket before any code is written. Do not edit files.",
        `Ticket: ${ctx.ticket.title}`,
        ctx.ticket.body,
        "Read CONTEXT.md and docs/adr. List: steps, files to touch, ADRs involved, risks, and the test plan.",
      ].join("\n\n"),
    );
    if (plan.status !== "ok") return outcomeFrom(plan, model);
    await ctx.tickets.comment(ctx.ticket.id, `Spike plan\n\n${plan.summary}`);

    // Scenarios come from a different model than the implementer and are stored outside the worktree.
    const author = pickReviewer(ctx.project, ctx.project.models.implement.model);
    const scen = await callModel(
      deps,
      ctx,
      author,
      [
        "Write acceptance scenarios for this ticket that a black-box tester can check against the running software.",
        `Ticket: ${ctx.ticket.title}`,
        ctx.ticket.body,
        'Reply with JSON only: {"scenarios":[{"id":"s1","given":"...","when":"...","then":"..."}]} with 3 to 12 scenarios.',
      ].join("\n\n"),
    );
    if (scen.status !== "ok") return outcomeFrom(scen, author);
    try {
      const scenarios = parseScenarios(scen.summary);
      await deps.holdout.save(ctx.project.id, ctx.ticket.id, scenarios);
      ctx.emit(`stored ${scenarios.length} holdout scenarios`, "log");
    } catch (error) {
      return {
        ok: false,
        summary: `holdout scenarios unparseable: ${(error as Error).message}`,
        receipts: [],
        runStatus: "failed",
      };
    }
    return outcomeFrom(plan, model, [
      { kind: "log", ok: true, summary: "spike plan recorded on ticket" },
    ]);
  };

const implement =
  (deps: HandlerDeps): PhaseHandler =>
  async (ctx) => {
    const model = modelFor(ctx, "implement");
    const loopNote = ctx.workflow.lastError
      ? `This is iteration ${ctx.workflow.loops + 1}. Fix this first: ${ctx.workflow.lastError}`
      : "";
    const result = await callModel(
      deps,
      ctx,
      model,
      [
        `Implement this ticket on branch ${ctx.branch}.`,
        `Ticket: ${ctx.ticket.title}`,
        ctx.ticket.body,
        loopNote,
        "Follow the spike plan in the ticket comments, CONTEXT.md and docs/adr. Write tests. Commit with clear messages. Never push to the base branch.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    return outcomeFrom(result, model);
  };

const checks =
  (deps: HandlerDeps): PhaseHandler =>
  async (ctx) => {
    if (!deps.sandbox)
      return {
        ok: false,
        summary: "no sandbox configured for checks",
        receipts: [],
        runStatus: "failed",
      };
    if (ctx.project.checks.length === 0)
      return { ok: false, summary: "no checks configured", receipts: [] };
    const receipts: Receipt[] = [];
    for (const check of ctx.project.checks) {
      ctx.emit(`running ${check.kind}: ${check.cmd.join(" ")}`, "tool");
      const res = await deps.sandbox.exec(
        {
          workdir: ctx.workdir,
          cmd: check.cmd,
          network: "none",
          timeoutMs: ctx.project.runTimeoutMs,
        },
        ctx.signal,
      );
      receipts.push({
        kind: check.kind,
        ok: res.code === 0,
        summary: `${check.kind} exit ${res.code}`,
        data: { cmd: check.cmd, output: tail(`${res.stdout}\n${res.stderr}`) },
      });
    }
    const ok = receipts.every((r) => r.ok);
    return { ok, summary: ok ? "checks passed" : "checks failed", receipts, runStatus: "ok" };
  };

const review =
  (deps: HandlerDeps): PhaseHandler =>
  async (ctx) => {
    const reviewer = pickReviewer(ctx.project, ctx.workflow.implementerModel);
    const receipts: Receipt[] = [];
    let costUsd = 0;
    for (const lane of ctx.project.reviewLanes) {
      ctx.emit(`review lane ${lane} on ${reviewer.model}`, "log");
      const result = await callModel(
        deps,
        ctx,
        reviewer,
        lanePrompt(lane, ctx.ticket.title, ctx.ticket.body, ctx.project.baseBranch),
      );
      costUsd += result.costUsd ?? 0;
      if (result.status !== "ok") return { ...outcomeFrom(result, reviewer, receipts), costUsd };
      try {
        receipts.push(reviewReceipt(lane, reviewer.model, parseFindings(result.summary)));
      } catch (error) {
        return {
          ok: false,
          summary: `${lane} review output unparseable: ${(error as Error).message}`,
          receipts,
          runStatus: "failed",
          model: reviewer.model,
          costUsd,
        };
      }
    }
    const p1 = receipts.flatMap(findingsOf).filter((f) => f.severity === "P1").length;
    return {
      ok: p1 === 0,
      summary: `${receipts.length} lanes, ${p1} P1`,
      receipts,
      runStatus: "ok",
      model: reviewer.model,
      runner: reviewer.runner,
      costUsd,
    };
  };

const qa =
  (deps: HandlerDeps): PhaseHandler =>
  async (ctx) => {
    if (!deps.qa)
      return { ok: false, summary: "no QA driver configured", receipts: [], runStatus: "failed" };
    const evidence = await deps.qa.run(ctx);
    const scenarios = await deps.holdout.load(ctx.project.id, ctx.ticket.id);
    if (scenarios.length === 0) {
      return {
        ok: false,
        summary: "no holdout scenarios stored for this ticket",
        receipts: evidence,
        runStatus: "ok",
      };
    }
    const judge = pickReviewer(ctx.project, ctx.workflow.implementerModel);
    const verdict = await callModel(
      deps,
      ctx,
      judge,
      [
        "Judge whether the software in this working tree satisfies each scenario. You may run it and its tests; do not edit files.",
        `QA evidence:\n${evidence.map((r) => `- ${r.kind} ${r.ok ? "ok" : "FAILED"}: ${r.summary}`).join("\n")}`,
        `Scenarios:\n${JSON.stringify(scenarios, null, 2)}`,
        'Reply with JSON only: {"verdicts":[{"id":"s1","satisfied":true,"reason":"..."}]}',
      ].join("\n\n"),
    );
    if (verdict.status !== "ok") return outcomeFrom(verdict, judge, evidence);
    try {
      const receipt = holdoutReceipt(scenarios, parseVerdicts(verdict.summary), judge.model);
      return {
        ok: evidence.every((r) => r.ok),
        summary: receipt.summary,
        receipts: [...evidence, receipt],
        runStatus: "ok",
        model: judge.model,
        ...(verdict.costUsd !== undefined ? { costUsd: verdict.costUsd } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        summary: `holdout verdicts unparseable: ${(error as Error).message}`,
        receipts: evidence,
        runStatus: "failed",
      };
    }
  };

const merge =
  (deps: HandlerDeps): PhaseHandler =>
  async (ctx) => {
    if (!deps.merge) return { ok: false, summary: "no merge port configured", receipts: [] };
    const res = await deps.merge.merge(ctx, autonomyFor(ctx.project, "merge"));
    return {
      ok: res.ok,
      summary: res.summary,
      receipts: [
        { kind: "log", ok: res.ok, summary: res.summary, ...(res.url ? { url: res.url } : {}) },
      ],
    };
  };

const deploy =
  (deps: HandlerDeps): PhaseHandler =>
  async (ctx) => {
    if (!deps.deploy) return { ok: false, summary: "no deploy port configured", receipts: [] };
    const res = await deps.deploy.deploy(ctx);
    return {
      ok: res.ok,
      summary: res.summary,
      receipts: [
        { kind: "log", ok: res.ok, summary: res.summary, ...(res.url ? { url: res.url } : {}) },
      ],
    };
  };

const verify =
  (deps: HandlerDeps): PhaseHandler =>
  async (ctx) => {
    if (!deps.verify) return { ok: false, summary: "no verify port configured", receipts: [] };
    const receipts = await deps.verify.verify(ctx);
    const ok = receipts.length > 0 && receipts.every((r) => r.ok);
    return {
      ok,
      summary: ok ? "post-deploy verification passed" : "post-deploy verification failed",
      receipts,
    };
  };

const compound =
  (deps: HandlerDeps): PhaseHandler =>
  async (ctx) => {
    const runs = await deps.store.listRuns({ projectId: ctx.project.id, ticketId: ctx.ticket.id });
    let count = 0;
    for (const run of runs.filter((r) => r.phase === "review")) {
      for (const receipt of await deps.store.listReceipts(run.id)) {
        for (const f of findingsOf(receipt)) {
          await deps.store.addLesson({
            projectId: ctx.project.id,
            ticketId: ctx.ticket.id,
            source: `review:${(receipt.data as { lane?: string } | undefined)?.lane ?? "unknown"}`,
            lesson: `${f.severity} ${f.title}${f.file ? ` (${f.file})` : ""}`,
          });
          count += 1;
        }
      }
    }
    return { ok: true, summary: `recorded ${count} candidate lessons`, receipts: [] };
  };

export function createDefaultHandlers(deps: HandlerDeps): PhaseHandlers {
  return {
    spike: spike(deps),
    implement: implement(deps),
    checks: checks(deps),
    review: review(deps),
    qa: qa(deps),
    merge: merge(deps),
    deploy: deploy(deps),
    verify: verify(deps),
    compound: compound(deps),
  };
}
