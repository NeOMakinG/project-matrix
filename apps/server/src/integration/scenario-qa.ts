import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Sandbox } from "@matrix/core";
import {
  extractJson,
  FactoryToolingError,
  type GitPort,
  hasAbsenceClaim,
  type JudgeScenarioEvidence,
  type PhaseContext,
  phaseTimeoutMs,
  QA_JUDGE_CRITERIA,
  type QaDriver,
  type Receipt,
  type Runner,
  type RunnerId,
  resolveModel,
  retryPrivateQa,
  type ScenarioEvidence,
  selectModel,
  vouchedToolingError,
} from "@matrix/core";
import { scanSecretText, secretNeedles } from "@matrix/sandbox";
import { z } from "zod";
import type { PrivateStateOwner } from "../state-owner.js";
import { redactNativeDiagnostic } from "./native-diagnostics.js";
import { publishOwnedFile } from "./owned-files.js";
import type { QaSnapshot } from "./qa-snapshot.js";

const probePlan = z
  .object({
    probes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            tool: z.enum(["bun", "node", "python3"]),
            source: z.string().min(1).max(8192),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();

export function scenarioQaDriver(options: {
  sandbox: Sandbox;
  runners: Partial<Record<RunnerId, Runner>>;
  git: GitPort;
  snapshot(ctx: PhaseContext): Promise<QaSnapshot>;
  secrets(): Promise<string[]>;
  scanOutput?(text: string): Promise<boolean>;
  gitleaksBinary?: string;
  owner?: PrivateStateOwner;
}): QaDriver {
  return {
    // Host probes only: no Android/iOS device driver runs here (manual handoff covers those).
    surfaces: ["host", "api", "web"],
    // Throw sites vouch for their own fixed messages (vouchedToolingError); nothing is vouched here.
    run: (ctx, request) => runScenarioQa(options, ctx, request),
  };
}

type ScenarioQaOptions = Parameters<typeof scenarioQaDriver>[0];

async function runScenarioQa(
  options: ScenarioQaOptions,
  ctx: PhaseContext,
  request: Parameters<QaDriver["run"]>[1],
): ReturnType<QaDriver["run"]> {
  const signal = options.owner ? AbortSignal.any([ctx.signal, options.owner.signal]) : ctx.signal;
  const check = () => {
    signal.throwIfAborted();
    options.owner?.assertOwned();
  };
  check();
  if (!request) throw vouchedToolingError("QA requires private holdout scenario context");
  const implementer =
    ctx.workflow.implementerModel ?? selectModel(ctx.project, "implement", ctx.ticket).model;
  const reviewerModel = resolveModel(ctx.project, request.reviewer.model);
  if (reviewerModel === implementer || reviewerModel === resolveModel(ctx.project, implementer))
    throw vouchedToolingError("QA probes require a reviewer model distinct from the implementer");
  if (ctx.project.checks.length > 32)
    throw vouchedToolingError("QA check count exceeds resource limits");
  const secrets = await options.secrets();
  check();
  const redact = redactNativeDiagnostic(secrets);
  const snapshot = await options.snapshot({ ...ctx, signal });
  check();
  const bound = async () => {
    check();
    if (
      !(await options.git.isClean(ctx.workdir)) ||
      (await options.git.headSha(ctx.workdir)) !== snapshot.headSha
    )
      throw vouchedToolingError(
        "QA original worktree or committed SHA changed during isolated probes",
      );
    check();
  };
  const receipts: Receipt[] = [];
  const judgeEvidence: JudgeScenarioEvidence[] = [];
  const execute = async (cmd: string[], probe?: { id: string; source: string; file: string }) => {
    await bound();
    const directory = await ctx.scratchDir();
    check();
    snapshot.materialize(directory);
    if (probe)
      publishOwnedFile({
        root: directory,
        path: join(directory, probe.file),
        content: probe.source,
        createOnly: true,
        owner: options.owner,
      });
    const started = performance.now();
    const result = await options.sandbox
      .exec(
        {
          workdir: directory,
          cmd,
          network: "none",
          timeoutMs: Math.min(phaseTimeoutMs(ctx.project, "qa"), 60_000),
          maxOutputBytes: 4096,
          readOnly: probe !== undefined,
        },
        signal,
      )
      .catch(() => {
        check();
        throw vouchedToolingError(
          "QA host probe execution unavailable; no scenario evidence was attested",
          receipts,
        );
      });
    await bound();
    const durationMs = Math.max(0, performance.now() - started);
    const raw = `${result.stdout}\n${result.stderr}`;
    const clean = await (
      options.scanOutput ?? ((text) => scanSecretText(text, options.gitleaksBinary))
    )(`${probe?.source ?? ""}\n${raw}`).catch(() => false);
    await bound();
    const output = clean
      ? redact(raw).slice(0, 4096)
      : `output withheld; sha256=${createHash("sha256").update(raw).digest("hex")}`;
    return {
      exitCode: result.code,
      output,
      probe: clean ? redact(probe?.source ?? "") : "probe withheld",
      durationMs,
      probeSha256: createHash("sha256")
        .update(probe?.source ?? "")
        .digest("hex"),
      outputSha256: createHash("sha256").update(raw).digest("hex"),
      probeBytes: Buffer.byteLength(probe?.source ?? ""),
      outputBytes: Buffer.byteLength(raw),
    };
  };
  for (const command of ctx.project.checks) {
    if (command.kind === "adr-check") continue;
    const result = await execute(command.cmd);
    receipts.push({
      kind: command.kind,
      ok: result.exitCode === 0,
      summary: `isolated QA ${command.kind} exit ${result.exitCode}`,
      data: {
        headSha: snapshot.headSha,
        outputSha256: result.outputSha256,
        outputBytes: result.outputBytes,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        passed: result.exitCode === 0,
      },
    });
  }
  if (!request.scenarios.length) return receipts;
  if (
    request.scenarios.length > 16 ||
    new Set(request.scenarios.map((item) => item.id)).size !== request.scenarios.length
  )
    throw vouchedToolingError("QA requires at most 16 distinct private scenarios", receipts);
  const runner = options.runners[request.reviewer.runner];
  if (!runner) throw vouchedToolingError("QA reviewer runner is unavailable", receipts);
  await bound();
  let planningCost = 0;
  const probes = await retryPrivateQa(signal, async () => {
    await bound();
    const plan = await runner
      .run(
        {
          runId: `${ctx.runId}-probes`,
          projectId: ctx.project.id,
          ticketId: ctx.ticket.id,
          phase: "qa",
          runner: request.reviewer.runner,
          model: reviewerModel,
          workdir: snapshot.directory,
          readOnly: true,
          timeoutMs: phaseTimeoutMs(ctx.project, "qa"),
          prompt: [
            "Design executable acceptance probes for these private holdout scenarios. You are the QA reviewer, not the implementer.",
            "Source is a read-only disposable snapshot of the reviewed committed SHA; no git metadata is available. Do not write files or claim execution results.",
            ...(snapshot.placeholders
              ? [
                  `${snapshot.placeholders} large or binary committed files are empty placeholders: never read or assert on them; a scenario that depends on their content must fail its probe with an explanatory message. Placeholders${snapshot.placeholders > (snapshot.placeholderPaths?.length ?? 0) ? " (first 100)" : ""}: ${JSON.stringify(snapshot.placeholderPaths ?? [])}`,
                ]
              : []),
            "Return one probe per scenario. The host will write and execute each probe in a separate fresh copy, with no network, credentials, or worktree access.",
            "Use bun for TypeScript, node for JavaScript, or python3 for Python. Each probe resides in the project root: import the actual software with relative paths, assert scenario behavior, print observed values, and exit nonzero on failure. Do not simulate the implementation or merely print claims.",
            QA_JUDGE_CRITERIA,
            "Assert every part of each scenario's then clause. For absence claims install instrumentation before importing the software and assert zero calls for every named surface; import-time I/O counts too. Restore instrumentation before printing probe diagnostics. Do not substitute global key comparisons for I/O instrumentation.",
            `Commit: ${snapshot.headSha}`,
            `Scenarios: ${JSON.stringify(request.scenarios)}`,
            'Reply with JSON only: {"probes":[{"id":"s1","tool":"bun","source":"..."}]}',
          ].join("\n\n"),
        },
        () => ctx.emit("QA probe planner activity", "log"),
        signal,
      )
      .catch(() => {
        throw vouchedToolingError(
          "QA probe planning failed; private evidence unavailable",
          receipts,
        );
      });
    await bound();
    planningCost += plan.costUsd ?? 0;
    if (plan.status !== "ok")
      throw vouchedToolingError(
        "QA probe planning failed; private evidence unavailable",
        receipts,
        planningCost,
      );
    let probes: z.infer<typeof probePlan>["probes"];
    try {
      if (plan.status !== "ok" || plan.summary.length > 256 * 1024)
        throw new Error("invalid planner result");
      probes = probePlan.parse(extractJson(plan.summary)).probes;
      if (
        probes.length !== request.scenarios.length ||
        new Set(probes.map((item) => item.id)).size !== probes.length ||
        probes.some((probe) => !request.scenarios.some((item) => item.id === probe.id))
      )
        throw new Error("scenario coverage mismatch");
      for (const probe of probes) {
        const scenario = request.scenarios.find((item) => item.id === probe.id)!;
        if (
          hasAbsenceClaim(scenario.then) &&
          (!/\b(?:spyOn|mock|stub|patch|defineProperty|Proxy)\b|\b(?:console|fs|net)\s*\.\s*\w+\s*=/i.test(
            probe.source,
          ) ||
            !/\b(?:assert\w*|expect|throw|raise|exit)\b/i.test(probe.source))
        )
          throw new Error("absence claim lacks probe instrumentation");
        if (
          /\b(?:no|without)\s+(?:observable\s+)?I\/O\b/i.test(scenario.then) &&
          !["fs", "net", "console"].every((surface) =>
            new RegExp(`\\b${surface}\\b`, "i").test(probe.source),
          )
        )
          throw new Error("I/O absence lacks surface coverage");
      }
      const needles = secrets
        .flatMap((secret) => [Buffer.from(secret), ...secretNeedles(secret)])
        .filter((needle) => needle.length);
      if (
        probes.some((probe) => needles.some((needle) => Buffer.from(probe.source).includes(needle)))
      )
        throw new Error("secret in probe");
    } catch {
      throw vouchedToolingError(
        "QA planner must provide executable, credential-free probes for every scenario; model-claimed evidence is not trusted",
        receipts,
        planningCost,
      );
    }
    return probes;
  }).catch((error: unknown) => {
    // Keep the specific tooling reason (e.g. worktree changed) but always report all planning spend.
    // An inner cause is forwarded only when its own throw site vouched for it.
    const inner = error instanceof FactoryToolingError ? error.operatorCause : undefined;
    throw vouchedToolingError(
      inner ?? "QA probe planning failed; private evidence unavailable",
      receipts,
      planningCost,
    );
  });
  for (const [index, probe] of probes.entries()) {
    const file = `.matrix-qa-probe-${index}.${probe.tool === "bun" ? "ts" : probe.tool === "node" ? "mjs" : "py"}`;
    const command = [probe.tool, file];
    const result = await execute(command, { ...probe, file });
    const data: ScenarioEvidence = {
      provenance: "host-probe",
      headSha: snapshot.headSha,
      scenarioIndex: request.scenarios.findIndex((item) => item.id === probe.id),
      probeSha256: result.probeSha256,
      outputSha256: result.outputSha256,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      probeBytes: result.probeBytes,
      outputBytes: result.outputBytes,
      passed: result.exitCode === 0,
      plannerModel: reviewerModel,
    };
    judgeEvidence.push({
      headSha: snapshot.headSha,
      id: probe.id,
      command,
      exitCode: result.exitCode,
      output: result.output,
      probe: result.probe,
    });
    receipts.push({
      kind: "test",
      ok: result.exitCode === 0,
      summary: `host-executed QA probe exit ${result.exitCode}`,
      data,
    });
  }
  await bound();
  return {
    receipts,
    judgeEvidence,
    ...(planningCost > 0 ? { costUsd: planningCost } : {}),
  };
}
