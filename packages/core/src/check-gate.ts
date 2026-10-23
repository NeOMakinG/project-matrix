import {
  type BaselinePort,
  type BaselineRun,
  type BaselineVerdict,
  compareToBase,
  MAX_LISTED,
  newFailures,
} from "./check-baseline.js";
import { confirmByRetry } from "./check-flaky.js";
import { type Failure, failureText, resolveParser } from "./check-parsers.js";
import { runCheck } from "./check-run.js";
import { FactoryToolingError } from "./factory-error.js";
import type { Receipt, Sandbox } from "./ports.js";
import type { PhaseContext } from "./ports-internal.js";
import type { CheckCommand } from "./types.js";

type BaseResult = BaselineRun | { error: string } | undefined;

/** Test checks retry once before a new failure counts, unless `retryFlaky: false`. */
const retries = (check: CheckCommand) => check.kind === "test" && check.retryFlaky !== false;

/** All new failures of a compare-mode run (uncapped), or undefined when not comparable. */
function freshOf(run: BaselineRun, base: BaseResult): Failure[] | undefined {
  if (run.code === 0 || run.failures === null || !base || "error" in base) return undefined;
  if (base.code === 0) return run.failures;
  return base.failures === null ? undefined : newFailures(run.failures, base.failures);
}

/** Baseline mode of a check: explicit, else strict for exit-code checks, else the port default. */
export function checkMode(port: BaselinePort, ctx: PhaseContext, check: CheckCommand) {
  return (
    check.baseline ?? (resolveParser(check) === "exit-code" ? "strict" : port.defaultMode(ctx))
  );
}

/**
 * Starts the base run of every compare-mode check in the background (ticket start, in parallel
 * with implement) so the checks phase finds cached results. Detached from the phase: its own
 * signal, no events; failures are ignored (the checks phase simply runs the base itself).
 */
export function warmBaseline(port: BaselinePort, ctx: PhaseContext): void {
  if (!port.warm || !ctx.project.baselineWarmup) return;
  const checks = ctx.project.checks.filter((c) => checkMode(port, ctx, c) === "compare");
  if (!checks.length) return;
  const quiet: PhaseContext = { ...ctx, emit: () => {}, signal: new AbortController().signal };
  void port.warm(quiet, checks).catch(() => undefined);
}

/**
 * Re-gates each failed compare-mode check against the base commit (only failing checks need a
 * baseline), re-runs test checks once to separate flaky failures from real ones, and stores the
 * full lists as host-side evidence. Receipts keep their slot; `ok` and `data.baseline` carry
 * the verdict.
 */
export async function applyBaseline(
  port: BaselinePort,
  sandbox: Sandbox,
  ctx: PhaseContext,
  runs: BaselineRun[],
  receipts: Receipt[],
  /**
   * Restores the run tree to the checked commit (untracked files wiped, dependencies reinstalled)
   * so the first run cannot leave state that makes the retry pass. Without it: no retries.
   */
  resetForRetry?: (ctx: PhaseContext) => Promise<void>,
): Promise<void> {
  const checks = ctx.project.checks;
  const offset = receipts.length - checks.length;
  // An exit-code-only check cannot tell new failures from old ones: compare only on explicit opt-in.
  const mode = (i: number) => checkMode(port, ctx, checks[i] as CheckCommand);
  const wanted = checks.flatMap((c, i) => (mode(i) === "compare" && runs[i]?.code ? [i] : []));
  let base: Awaited<ReturnType<BaselinePort["run"]>> | undefined;
  let error = "";
  if (wanted.length) {
    ctx.emit(`baseline: running ${wanted.length} failing check(s) on the base commit`, "tool");
    try {
      base = await port.run(
        ctx,
        wanted.map((i) => checks[i] as CheckCommand),
      );
    } catch (e) {
      if (e instanceof FactoryToolingError) throw e;
      error = e instanceof Error ? e.message.slice(0, 200) : "baseline error";
    }
  }
  for (const [i, check] of checks.entries()) {
    const run = runs[i] as BaselineRun;
    const receipt = receipts[offset + i] as Receipt;
    const parser = resolveParser(check);
    const at = wanted.indexOf(i);
    const baseRun: BaseResult =
      at < 0 ? undefined : (base?.results[at] ?? { error: error || "no baseline result" });
    let verdict: BaselineVerdict =
      mode(i) === "strict"
        ? {
            mode: "strict",
            parser,
            ok: run.code === 0,
            newFailures: (run.failures ?? []).slice(0, MAX_LISTED).map(failureText),
            newCount: run.code === 0 ? 0 : Math.max(1, run.failures?.length ?? 1),
            preExisting: 0,
            note: run.code === 0 ? "passed" : "strict: any failure fails",
          }
        : compareToBase(parser, run, baseRun, base?.baseSha);
    let fresh = mode(i) === "compare" ? freshOf(run, baseRun) : undefined;
    let flaky: Failure[] = [];
    if (!verdict.ok && fresh?.length && retries(check) && resetForRetry) {
      const retry = await resetForRetry(ctx)
        .then(() => runCheck(sandbox, ctx, check, { structured: true, label: "retry" }))
        .then((r) => r.run)
        .catch((e: unknown) => {
          if (e instanceof FactoryToolingError) throw e;
          return undefined;
        });
      const baseFailures =
        baseRun && !("error" in baseRun) && baseRun.code !== 0 ? (baseRun.failures ?? []) : [];
      const split = confirmByRetry(fresh, retry, baseFailures);
      fresh = split.confirmed;
      flaky = split.flaky;
      verdict = {
        ...verdict,
        ok: split.confirmed.length === 0,
        newFailures: split.confirmed.slice(0, MAX_LISTED).map(failureText),
        newCount: split.confirmed.length,
        note: split.confirmed.length
          ? `${split.confirmed.length} new vs base, reproduced on retry${split.note ? `; ${split.note}` : ""}`
          : `only pre-existing failures; ${split.note ?? "new ones passed on retry"}`,
        ...(flaky.length ? { flaky: flaky.slice(0, MAX_LISTED).map(failureText) } : {}),
      };
    }
    if (run.code !== 0 && port.evidence) {
      const all = run.failures ?? [];
      const preExisting = fresh ? newFailures(all, [...fresh, ...flaky]) : [];
      const ref = await port
        .evidence(ctx, {
          kind: check.kind,
          index: i,
          parser,
          mode: verdict.mode,
          ...(verdict.baseSha ? { baseSha: verdict.baseSha } : {}),
          note: verdict.note,
          newFailures: (fresh ?? all).map(failureText),
          preExisting: preExisting.map(failureText),
          flaky: flaky.map(failureText),
        })
        .catch(() => undefined);
      if (ref) verdict = { ...verdict, evidence: ref };
    }
    receipt.ok = verdict.ok;
    const extra = `${verdict.preExisting > 0 ? `, ${verdict.preExisting} pre-existing` : ""}${flaky.length ? `, ${flaky.length} flaky` : ""}`;
    receipt.summary = `${receipt.summary} · ${verdict.newCount} new${extra} (${verdict.mode})`;
    receipt.data = { ...(receipt.data as object), baseline: verdict };
  }
}
