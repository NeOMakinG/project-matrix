import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Sandbox } from "@matrix/core";
import {
  extractJson,
  FactoryToolingError,
  type GitPort,
  type PhaseContext,
  type QaDriver,
  type Receipt,
  type Runner,
  type RunnerId,
  type ScenarioEvidence,
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
    async run(ctx, request) {
      const signal = options.owner
        ? AbortSignal.any([ctx.signal, options.owner.signal])
        : ctx.signal;
      const check = () => {
        signal.throwIfAborted();
        options.owner?.assertOwned();
      };
      check();
      if (!request) throw new FactoryToolingError("QA requires private holdout scenario context");
      if (
        request.reviewer.model ===
        (ctx.workflow.implementerModel ?? ctx.project.models.implement.model)
      )
        throw new FactoryToolingError(
          "QA probes require a reviewer model distinct from the implementer",
        );
      if (ctx.project.checks.length > 32)
        throw new FactoryToolingError("QA check count exceeds resource limits");
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
          throw new FactoryToolingError(
            "QA original worktree or committed SHA changed during isolated probes",
          );
        check();
      };
      const receipts: Receipt[] = [];
      const execute = async (
        cmd: string[],
        probe?: { id: string; source: string; file: string },
      ) => {
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
        const result = await options.sandbox
          .exec(
            {
              workdir: directory,
              cmd,
              network: "none",
              timeoutMs: Math.min(ctx.project.runTimeoutMs, 60_000),
              maxOutputBytes: 4096,
              readOnly: probe !== undefined,
            },
            signal,
          )
          .catch(() => {
            check();
            throw new FactoryToolingError(
              "QA host probe execution unavailable; no scenario evidence was attested",
              receipts,
            );
          });
        await bound();
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
            output: result.output,
          },
        });
      }
      if (!request.scenarios.length) return receipts;
      if (
        request.scenarios.length > 16 ||
        new Set(request.scenarios.map((item) => item.id)).size !== request.scenarios.length
      )
        throw new FactoryToolingError(
          "QA requires at most 16 distinct private scenarios",
          receipts,
        );
      const runner = options.runners[request.reviewer.runner];
      if (!runner) throw new FactoryToolingError("QA reviewer runner is unavailable", receipts);
      await bound();
      const plan = await runner
        .run(
          {
            runId: `${ctx.runId}-probes`,
            projectId: ctx.project.id,
            ticketId: ctx.ticket.id,
            phase: "qa",
            runner: request.reviewer.runner,
            model: request.reviewer.model,
            workdir: snapshot.directory,
            readOnly: true,
            timeoutMs: ctx.project.runTimeoutMs,
            prompt: [
              "Design executable acceptance probes for these private holdout scenarios. You are the QA reviewer, not the implementer.",
              "Source is a read-only disposable snapshot of the reviewed committed SHA; no git metadata is available. Do not write files or claim execution results.",
              "Return one probe per scenario. The host will write and execute each probe in a separate fresh copy, with no network, credentials, or worktree access.",
              "Use bun for TypeScript, node for JavaScript, or python3 for Python. Each probe resides in the project root: import the actual software with relative paths, assert scenario behavior, print observed values, and exit nonzero on failure. Do not simulate the implementation or merely print claims.",
              `Commit: ${snapshot.headSha}`,
              `Scenarios: ${JSON.stringify(request.scenarios)}`,
              'Reply with JSON only: {"probes":[{"id":"s1","tool":"bun","source":"..."}]}',
            ].join("\n\n"),
          },
          () => ctx.emit("QA probe planner activity", "log"),
          signal,
        )
        .catch(() => {
          throw new FactoryToolingError(
            "QA probe planning failed; private evidence unavailable",
            receipts,
          );
        });
      await bound();
      if (plan.status !== "ok")
        throw new FactoryToolingError(
          "QA probe planning failed; private evidence unavailable",
          receipts,
          plan.costUsd,
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
        const needles = secrets
          .flatMap((secret) => [Buffer.from(secret), ...secretNeedles(secret)])
          .filter((needle) => needle.length);
        if (
          probes.some((probe) =>
            needles.some((needle) => Buffer.from(probe.source).includes(needle)),
          )
        )
          throw new Error("secret in probe");
      } catch {
        throw new FactoryToolingError(
          "QA planner must provide executable, credential-free probes for every scenario; model-claimed evidence is not trusted",
          receipts,
          plan.costUsd,
        );
      }
      for (const [index, probe] of probes.entries()) {
        const file = `.matrix-qa-probe-${index}.${probe.tool === "bun" ? "ts" : probe.tool === "node" ? "mjs" : "py"}`;
        const command = [probe.tool, file];
        const result = await execute(command, { ...probe, file });
        const data: ScenarioEvidence = {
          provenance: "host-probe",
          headSha: snapshot.headSha,
          id: probe.id,
          command,
          ...result,
        };
        receipts.push({
          kind: "test",
          ok: result.exitCode === 0,
          summary: `host-executed QA probe exit ${result.exitCode}`,
          data,
        });
      }
      await bound();
      return { receipts, ...(plan.costUsd !== undefined ? { costUsd: plan.costUsd } : {}) };
    },
  };
}
