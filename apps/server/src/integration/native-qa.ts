import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  createDefaultHandlers,
  EventBus,
  HoldoutStore,
  MemoryStore,
  type ProjectConfig,
  Reconciler,
  type RunRecord,
  type Store,
  scenarioEvidence,
} from "@matrix/core";
import { writeGraph } from "@matrix/graph";
import { MarkdownTicketStore } from "@matrix/tickets/adapters/markdown";
import { redactNativeDiagnostic as nativeQaRedactor } from "./native-diagnostics.js";
import { type NativeRuntimeOptions, nativeRuntime } from "./native-runtime.js";

const exec = promisify(execFile);

export { nativeQaRedactor };
export async function nativeQaEvidence(
  store: Pick<Store, "listEvents" | "getStep" | "listReceipts">,
  runs: RunRecord[],
  redact: (value: string) => string,
) {
  let remainingBytes = 64 * 1024;
  const message = (value: string | undefined): string | null => {
    if (value === undefined || remainingBytes === 0) return null;
    const clean = redact(value);
    const limit = Math.min(2048, remainingBytes);
    const bytes = Buffer.from(clean);
    remainingBytes -= Math.min(bytes.length, limit);
    return bytes.subarray(0, limit).toString("utf8") + (bytes.length > limit ? " [truncated]" : "");
  };
  const evidence = [];
  for (const run of runs.slice(-64)) {
    const summary = message(run.summary);
    const events = await store.listEvents(run.id).catch(() => undefined);
    const relevant = events?.filter((event) => event.kind === "error" || event.kind === "log");
    const selected = relevant
      ? [
          ...relevant.filter((event) => event.kind === "error").slice(-12),
          ...relevant.filter((event) => event.kind === "log").slice(-12),
        ]
      : [];
    const savedStep = await store.getStep(run.stepKey).catch(() => undefined);
    const step = savedStep?.runId === run.id ? savedStep : undefined;
    const output = step?.output && typeof step.output === "object" ? step.output : undefined;
    const stepSummary =
      output && "summary" in output && typeof output.summary === "string"
        ? output.summary
        : undefined;
    evidence.push({
      id: redact(run.id),
      phase: run.phase,
      status: run.status,
      headSha: run.headSha ?? null,
      model: run.model ? redact(run.model) : null,
      summary,
      summaryStatus: run.summary === undefined ? "unavailable" : "available",
      events: {
        status: events === undefined ? "unavailable" : "available",
        messages: selected.map((event) => ({ kind: event.kind, message: message(event.message) })),
        omittedCount: relevant === undefined ? null : relevant.length - selected.length,
      },
      step: {
        status: step ? "available" : "unavailable",
        ok: step?.ok ?? null,
        summary: message(stepSummary),
        summaryStatus: stepSummary === undefined ? "unavailable" : "available",
        runStatus:
          output &&
          "runStatus" in output &&
          ["ok", "failed", "timeout", "cancelled"].includes(String(output.runStatus))
            ? String(output.runStatus)
            : null,
      },
      receipts: (await store.listReceipts(run.id)).map((receipt) => {
        const probe = scenarioEvidence(receipt);
        return {
          kind: receipt.kind,
          ok: receipt.ok,
          summary: message(receipt.summary),
          ...(probe
            ? {
                scenario: {
                  provenance: probe.provenance,
                  headSha: redact(probe.headSha),
                  id: redact(probe.id),
                  command: probe.command.map(redact),
                  exitCode: probe.exitCode,
                  output: message(probe.output),
                  probe: message(probe.probe),
                },
              }
            : {}),
        };
      }),
    });
  }
  return evidence;
}

export async function writeNativeQaReceipt(
  path: string,
  report: unknown,
  redact: (value: string) => string,
) {
  const content = JSON.stringify(
    report,
    (_key, value: unknown) => (typeof value === "string" ? redact(value) : value),
    2,
  );
  await writeFile(path, `${content}\n`, { mode: 0o600 });
}

class NativeQaFailure extends Error {
  constructor(readonly receipt: string) {
    super("native QA failed; inspect private receipt");
  }
}

function shortReceipt(path: string) {
  return join(basename(dirname(path)), basename(path));
}

export async function runNativeQa(
  outputRoot: string,
  options: Omit<NativeRuntimeOptions, "workspace" | "dataDir">,
): Promise<string> {
  if (platform() !== "linux") throw new Error("native QA is coordinator-only on the Linux host");
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(outputRoot, "tiny-ticket-"));
  const repo = join(directory, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "test"));
  await mkdir(join(repo, "docs/adr"), { recursive: true });
  await writeFile(
    join(repo, "CONTEXT.md"),
    "Harmless native QA fixture. Pure arithmetic only. No external services, deployment or credentials.\n",
  );
  await writeFile(
    join(repo, "docs/adr/0001-pure.md"),
    "# Pure arithmetic\nAccepted: add sums two numbers, including zero and negatives. No I/O.\n",
  );
  await writeFile(join(repo, ".gitignore"), "node_modules/\ndist/\n");
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      name: "matrix-native-qa-fixture",
      type: "module",
      scripts: { test: "bun test" },
    }),
  );
  await writeFile(
    join(repo, "src/add.ts"),
    "export function add(left: number, right: number): number { return 0; }\n",
  );
  await writeFile(
    join(repo, "test/add.test.ts"),
    'import { expect, test } from "bun:test";\nimport { add } from "../src/add";\nfor (const [left, right, expected] of [[0,0,0],[2,3,5],[-2,1,-1]]) test(`${left}+${right}`, () => expect(add(left!, right!)).toBe(expected!));\n',
  );
  const git = (...args: string[]) =>
    exec("git", [
      "-C",
      repo,
      "-c",
      "user.name=Matrix QA",
      "-c",
      "user.email=matrix-qa@localhost",
      ...args,
    ]).then((result) => result.stdout.trim());
  await writeGraph(repo);
  await git("init", "-q", "-b", "main");
  await git("add", ".");
  await git("commit", "-qm", "harmless native QA fixture");
  const base = await git("rev-parse", "HEAD");
  const runtime = nativeRuntime({
    ...options,
    workspace: "native",
    dataDir: join(directory, "runtime"),
  });
  const runTokens = new Set<string>();
  const grant = runtime.broker.grant.bind(runtime.broker);
  runtime.broker.grant = async (request) => {
    const result = await grant(request);
    runTokens.add(result.token);
    return result;
  };
  const store = new MemoryStore();
  const holdout = new HoldoutStore(join(directory, "holdout"));
  const tickets = new MarkdownTicketStore(join(directory, "tickets"));
  const project: ProjectConfig = {
    id: "native-qa",
    name: "Harmless native QA",
    repoPath: repo,
    baseBranch: "main",
    host: hostname(),
    models: {
      implement: { runner: "codex", model: "gpt-6.1-sol" },
      review: { runner: "codex", model: "gpt-6-sol" },
    },
    reviewerFallbacks: [],
    autonomy: { default: "autonomous", merge: "human", deploy: "human" },
    reviewLanes: ["correctness-security"],
    checks: [{ kind: "test", cmd: ["bun", "test"] }],
    holdoutThreshold: 1,
    maxLoops: 2,
    maxAttempts: 1,
    runTimeoutMs: 5 * 60_000,
  };
  await store.upsertProject(project);
  const ticket = await tickets.create({
    title: "Implement pure add",
    body: "Implement add(left,right) as pure addition in src/add.ts. Zero plus zero is zero; two plus three is five; negative two plus one is negative one. No I/O or dependencies. Keep the existing tests intact. Only edit src/add.ts.",
    labels: [],
  });
  await tickets.update(ticket.id, { status: "ready" });
  const reconciler = new Reconciler({
    store,
    bus: new EventBus(),
    workspace: runtime.workspace,
    git: runtime.git,
    tickets: () => tickets,
    handlers: createDefaultHandlers({
      ...runtime.deps,
      store,
      holdout,
      merge: {
        merge: async () => ({ ok: false, summary: "FAKE merge port: disabled for harmless QA" }),
      },
      deploy: {
        deploy: async () => ({ ok: false, summary: "FAKE deploy port: disabled for harmless QA" }),
      },
    }),
    limits: { perProject: 1, perModel: {}, defaultPerModel: 1, perHost: {}, defaultPerHost: 1 },
    backoff: { baseMs: 1000, maxMs: 1000 },
    host: project.host,
    scratchRoot: join(directory, "scratch"),
  });
  const stop = () => reconciler.stop();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    for (let iteration = 0; iteration < 30; iteration++) {
      await reconciler.tick();
      await reconciler.idle();
      const workflow = await store.getWorkflow(project.id, ticket.id);
      if (workflow?.phase === "merge" && workflow.status === "waiting_approval") break;
      if (workflow?.status === "blocked") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const runs = await store.listRuns({ projectId: project.id, ticketId: ticket.id });
    const secrets = await runtime.broker.secretValues().catch(() => undefined);
    const redact = secrets
      ? nativeQaRedactor([...secrets, ...runTokens])
      : (_value: string) => "[unavailable: credential redaction could not be established]";
    const evidence = await nativeQaEvidence(store, runs, redact);
    const validated = ["checks", "review", "qa"].map((phase) =>
      evidence.filter((run) => run.phase === phase && run.status === "ok").at(-1),
    );
    const workflow = await store.getWorkflow(project.id, ticket.id);
    const head = workflow?.workdir ? await runtime.git.headSha(workflow.workdir) : undefined;
    const sameCommittedSha = Boolean(
      head &&
        head !== base &&
        validated.every(
          (run) =>
            run?.headSha === head &&
            run.receipts.length &&
            run.receipts.every((receipt) => receipt.ok),
        ),
    );
    const ok =
      sameCommittedSha &&
      ["spike", "implement"].every((phase) =>
        evidence.some((run) => run.phase === phase && run.status === "ok"),
      ) &&
      validated[1]?.model === "gpt-6-sol" &&
      workflow?.phase === "merge" &&
      workflow.status === "waiting_approval" &&
      Boolean(workflow.workdir && (await runtime.git.isClean(workflow.workdir))) &&
      (await git("rev-parse", "main")) === base;
    const report = join(directory, "receipts.json");
    await writeNativeQaReceipt(
      report,
      {
        ok,
        sameCommittedSha,
        headSha: head ?? null,
        baseUnchanged: (await git("rev-parse", "main")) === base,
        runtime: "real rootless Podman / Codex / CLIProxyAPI",
        store: "memory only; not restart-persistence QA",
        merge: "FAKE disabled port; no merge attempted",
        deploy: "FAKE disabled port; no production deployment",
        workflow: { phase: workflow?.phase, status: workflow?.status },
        runs: evidence,
        diagnostics: secrets ? "redacted" : "unavailable",
      },
      redact,
    );
    if (!ok) throw new NativeQaFailure(report);
    return report;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    reconciler.stop();
    await reconciler.idle();
    await runtime.broker.closeAll();
  }
}

if (import.meta.main) {
  const {
    MATRIX_GATEWAY_URL,
    MATRIX_GATEWAY_KEY_FILE,
    MATRIX_GATEWAY_KEY_PATTERN,
    MATRIX_NATIVE_QA_OUTPUT,
  } = process.env;
  if (!MATRIX_GATEWAY_URL || !MATRIX_GATEWAY_KEY_FILE || !MATRIX_NATIVE_QA_OUTPUT)
    throw new Error("coordinator QA configuration is incomplete");
  try {
    const receipt = await runNativeQa(MATRIX_NATIVE_QA_OUTPUT, {
      gatewayUrl: MATRIX_GATEWAY_URL,
      gatewayKey: {
        file: MATRIX_GATEWAY_KEY_FILE,
        ...(MATRIX_GATEWAY_KEY_PATTERN ? { pattern: new RegExp(MATRIX_GATEWAY_KEY_PATTERN) } : {}),
      },
      image: process.env.MATRIX_RUNNER_IMAGE ?? "matrix-runner:dev",
      gitleaksBinary: process.env.MATRIX_GITLEAKS ?? "gitleaks",
    });
    console.log(`private receipt: ${shortReceipt(receipt)}`);
  } catch (error) {
    console.error(
      error instanceof NativeQaFailure
        ? `native QA failed; private receipt: ${shortReceipt(error.receipt)}`
        : "native QA unavailable; private receipt unavailable",
    );
    process.exitCode = 1;
  }
}
