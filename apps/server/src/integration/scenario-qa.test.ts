import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultHandlers,
  type HoldoutScenario,
  type PhaseContext,
  publicQaReceipt,
  type Receipt,
  type Sandbox,
  scenarioEvidence,
} from "@matrix/core";
import { createHarness, FakeRunner } from "@matrix/core/testing";
import { scanSecretText } from "@matrix/sandbox";
import { expect, test, vi } from "vitest";
import { nativeQaEvidence, nativeQaRedactor, writeNativeQaReceipt } from "./native-qa.js";
import { scenarioQaDriver } from "./scenario-qa.js";

const scenarios: HoldoutScenario[] = [
  { id: "s1", given: "zero operands", when: "add(0,0)", then: "returns 0" },
  { id: "s2", given: "positive operands", when: "add(2,3)", then: "returns 5" },
  { id: "s3", given: "negative operand", when: "add(-2,1)", then: "returns -1" },
  {
    id: "s4",
    given: "console.log stub installed before import",
    when: "repeated add(2,3)",
    then: "every call returns 5 and assert zero console.log calls using the stub",
  },
];

test("model alias is resolved when calling the probe planner", async () => {
  const setup = await fixture(true);
  try {
    setup.context.project.models.aliases = { "gpt-6-sol": "gateway-review" };
    await setup.driver.run(setup.context, {
      scenarios,
      reviewer: { runner: "codex", model: "gpt-6-sol" },
    });
    expect(setup.runner.calls[0]?.model).toBe("gateway-review");
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("model aliases cannot disguise a probe planner that is the implementer", async () => {
  const setup = await fixture(true);
  try {
    setup.context.project.models.aliases = { "gpt-6-sol": "gpt-6.1-sol" };
    await expect(
      setup.driver.run(setup.context, {
        scenarios,
        reviewer: { runner: "codex", model: "gpt-6-sol" },
      }),
    ).rejects.toThrow("distinct from the implementer");
    expect(setup.runner.calls).toHaveLength(0);
    expect(setup.executions).toHaveLength(0);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});
const probes = [
  ...[
    [0, 0, 0],
    [2, 3, 5],
    [-2, 1, -1],
  ].map(([left, right, expected], index) => ({
    id: `s${index + 1}`,
    tool: "bun",
    source: `import { add } from "./src/add.ts";\nconst actual = add(${left}, ${right});\nconsole.log(JSON.stringify({ actual, expected: ${expected} }));\nif (actual !== ${expected}) throw new Error("scenario failed");\n`,
  })),
  {
    id: "s4",
    tool: "bun",
    source:
      'const original = console.log;\nlet calls = 0;\nconsole.log = () => { calls++; };\nconst { add } = await import("./src/add.ts");\nconst sums = Array.from({length: 5}, () => add(2, 3));\nconsole.log = original;\nconsole.log(JSON.stringify({ sums, calls }));\nif (sums.some(sum => sum !== 5) || calls !== 0) throw new Error("side effect or inconsistent sum");\n',
  },
];

test("scenario writer regenerates unverifiable absence claims without exposing holdouts to implementer", async () => {
  const setup = await fixture(true);
  try {
    const writer = vi.spyOn(setup.harness.reviewer, "run");
    const result = (summary: string) => ({
      runId: "spike",
      status: "ok" as const,
      summary,
      receipts: [],
    });
    writer
      .mockResolvedValueOnce(result("public plan"))
      .mockResolvedValueOnce(
        result(
          JSON.stringify({
            scenarios: [{ ...scenarios[3], then: "returns 5 and produces no observable I/O" }],
          }),
        ),
      )
      .mockResolvedValueOnce(result(JSON.stringify({ scenarios })));
    const outcome = await createDefaultHandlers(setup.harness.deps).spike({
      ...setup.context,
      workflow: { ...setup.context.workflow, phase: "spike" },
    });
    expect(outcome.ok).toBe(true);
    expect(writer).toHaveBeenCalledTimes(3);
    const [implementer, firstAuthor, regeneration] = writer.mock.calls.map(([request]) => request);
    expect(implementer?.model).toBe("gpt-6.1-sol");
    expect(implementer?.prompt).not.toContain("holdout");
    expect(firstAuthor?.model).toBe("gpt-6-sol");
    expect(regeneration?.prompt).toContain("previous preparation failed validation");
    expect(firstAuthor?.workdir).not.toBe(setup.workdir);
    expect(
      await setup.harness.holdout.load(setup.context.project.id, setup.context.ticket.id),
    ).toEqual(scenarios);
    expect(JSON.stringify(outcome)).not.toContain("console.log stub");
    expect(JSON.stringify(setup.harness.tickets.comments)).not.toContain("console.log stub");
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("no I/O probe must cover fs, net, and console, not merely correct sums", async () => {
  const setup = await fixture(true);
  try {
    const outcome = await setup.driver
      .run(setup.context, {
        scenarios: scenarios.map((scenario) =>
          scenario.id === "s4"
            ? {
                ...scenario,
                then: "every call returns 5 and no observable I/O: stub fs/net/console and assert zero calls",
              }
            : scenario,
        ),
        reviewer: { runner: "codex", model: "gpt-6-sol" },
      })
      .catch((error) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(setup.runner.calls).toHaveLength(2);
    expect(setup.executions).toHaveLength(0);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("absence claims without instrumentation retry once and fail closed", async () => {
  const plan = JSON.stringify({
    probes: probes.map((probe) =>
      probe.id === "s4"
        ? {
            ...probe,
            source:
              'import { add } from "./src/add.ts"; if (add(2, 3) !== 5) throw new Error("wrong sum");',
          }
        : probe,
    ),
  });
  const setup = await fixture(true, plan);
  try {
    const outcome = await createDefaultHandlers(setup.harness.deps).qa(setup.context);
    expect(outcome).toMatchObject({
      ok: false,
      failureClass: "factory-tooling",
      model: "gpt-6-sol",
    });
    expect(setup.runner.calls).toHaveLength(2);
    expect(setup.executions).toHaveLength(0);
    expect(setup.harness.reviewer.calls).toHaveLength(0);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("instrumented absence assertion catches correct sums with console I/O", async () => {
  const setup = await fixture(true, undefined, "", 'console.log("unexpected I/O");');
  try {
    const outcome = await createDefaultHandlers(setup.harness.deps).qa(setup.context);
    expect(outcome.ok).toBe(false);
    expect(outcome.receipts.find((receipt) => receipt.kind === "holdout")?.data).toMatchObject({
      satisfied: 3,
      total: 4,
    });
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test.each(["error", "malformed"])(
  "planner and judge recover from one %s and record actual reviewer model",
  async (failure) => {
    const setup = await fixture(true);
    try {
      setup.context.project.models.aliases = { "gpt-6-sol": "gateway-review" };
      const planner = vi.spyOn(setup.runner, "run");
      const judge = vi.spyOn(setup.harness.reviewer, "run");
      if (failure === "error") {
        planner.mockRejectedValueOnce(new Error("private model error"));
        judge.mockRejectedValueOnce(new Error("private model error"));
      } else {
        const invalid = {
          runId: "invalid",
          status: "ok" as const,
          summary: "private malformed output",
          receipts: [],
        };
        planner.mockResolvedValueOnce(invalid);
        judge.mockResolvedValueOnce(invalid);
      }
      const outcome = await createDefaultHandlers(setup.harness.deps).qa(setup.context);
      expect(outcome).toMatchObject({ ok: true, model: "gateway-review" });
      expect(planner).toHaveBeenCalledTimes(2);
      expect(judge).toHaveBeenCalledTimes(2);
      expect(
        [...planner.mock.calls, ...judge.mock.calls].every(
          ([request]) => request.model === "gateway-review",
        ),
      ).toBe(true);
      expect(outcome.receipts.find((receipt) => receipt.kind === "holdout")?.data).toMatchObject({
        judgeModel: "gateway-review",
      });
      expect(
        outcome.receipts
          .filter((receipt) => scenarioEvidence(receipt))
          .every((receipt) => scenarioEvidence(receipt)?.plannerModel === "gateway-review"),
      ).toBe(true);
      expect(planner.mock.calls[0]?.[0].prompt).toContain(
        "Every assertion in the full then clause",
      );
      expect(judge.mock.calls[0]?.[0].prompt).toContain("Every assertion in the full then clause");
      expect(JSON.stringify(outcome)).not.toContain("private model error");
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  },
);

async function fixture(
  correct: boolean,
  plan = JSON.stringify({ probes }),
  committedSecret = "",
  sideEffect = "",
) {
  const root = await mkdtemp(join(tmpdir(), "matrix-qa-probes-"));
  const workdir = join(root, "worktree");
  const source = `export function add(left: number, right: number): number { ${sideEffect} return ${correct ? "left + right" : "0"}; }\nexport const fixtureSecret = ${JSON.stringify(committedSecret)};\n`;
  const materialize = (directory: string) => {
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src/add.ts"), source, { flag: "wx" });
  };
  materialize(workdir);
  const harness = createHarness({
    project: {
      models: {
        implement: { runner: "codex", model: "gpt-6.1-sol" },
        review: { runner: "codex", model: "gpt-6-sol" },
      },
      checks: [],
    },
    verdicts: () =>
      JSON.stringify({
        verdicts: scenarios.map((item) => ({
          id: item.id,
          satisfied: true,
          reason: "FAKE judge for regression; host failures must override this claim",
        })),
      }),
  });
  await harness.setup();
  const ticket = harness.tickets.add("addition");
  await harness.holdout.save(harness.project.id, ticket.id, scenarios);
  const planted = "planted-QA-gateway-secret-for-test";
  const runner = new FakeRunner("codex", () => ({
    summary: plan,
    costUsd: 0.125,
    receipts: [{ kind: "holdout", ok: true, summary: "UNTRUSTED model claim" }],
  }));
  const executions: string[] = [];
  const sandbox: Sandbox = {
    kind: "podman",
    async exec(spec) {
      expect(spec.network).toBe("none");
      expect(spec.env).toBeUndefined();
      expect(spec.maxOutputBytes).toBe(4096);
      expect(spec.readOnly).toBe(true);
      expect(spec.workdir).not.toBe(workdir);
      expect(await readdir(spec.workdir)).not.toContain(".git");
      executions.push(spec.workdir);
      const actual = spawnSync(spec.cmd[0]!, spec.cmd.slice(1), {
        cwd: spec.workdir,
        encoding: "utf8",
        timeout: spec.timeoutMs,
        maxBuffer: 8192,
      });
      return {
        code: actual.status ?? -1,
        stdout: actual.stdout,
        stderr: `${actual.stderr}\n${planted}\n${Buffer.from(planted).toString("base64")}`,
      };
    },
  };
  const head = "a".repeat(40);
  const headSha = vi.fn(async () => head);
  const context: PhaseContext = {
    project: harness.project,
    ticket,
    tickets: harness.tickets,
    runId: "qa-regression",
    workdir,
    workflow: {
      projectId: harness.project.id,
      ticketId: ticket.id,
      phase: "qa",
      status: "running",
      attempt: 0,
      loops: 0,
      priority: 1,
      version: 1,
      implementerModel: "gpt-6.1-sol",
    },
    branch: "matrix/tiny",
    idempotencyKey: "test",
    signal: new AbortController().signal,
    emit: () => {},
    scratchDir: () => mkdtemp(join(root, "scratch-")),
    stillOwner: async () => true,
    authorize: async () => ({ ok: false, kind: "gates", reason: "not used" }),
  };
  const scanOutput = vi.fn(async (_text: string) => true);
  const driver = scenarioQaDriver({
    sandbox,
    runners: { codex: runner },
    git: { headSha, isClean: async () => true, treeState: async () => head },
    snapshot: async (ctx) => {
      const directory = await ctx.scratchDir();
      materialize(directory);
      return { headSha: head, directory, materialize };
    },
    secrets: async () => [planted],
    scanOutput,
  });
  harness.deps.qa = driver;
  return {
    root,
    source,
    workdir,
    context,
    harness,
    driver,
    runner,
    executions,
    headSha,
    planted,
    scanOutput,
  };
}

test.each([true, false])(
  "host Bun probes on %s implementation (Git/sandbox/planner/judge doubles)",
  async (correct) => {
    const setup = await fixture(correct);
    try {
      const outcome = await createDefaultHandlers(setup.harness.deps).qa(setup.context);
      const holdout = outcome.receipts.filter((receipt) => receipt.kind === "holdout");
      expect(holdout).toHaveLength(1);
      expect(holdout[0]?.data).toMatchObject({
        provenance: "core-judge",
        satisfied: correct ? 4 : 1,
        total: 4,
        judgeModel: "gpt-6-sol",
      });
      expect(outcome.ok).toBe(correct);
      expect(setup.executions).toHaveLength(4);
      expect(new Set(setup.executions).size).toBe(4);
      const evidence = outcome.receipts.flatMap((receipt) => scenarioEvidence(receipt) ?? []);
      expect(evidence).toHaveLength(4);
      expect(evidence.every((item) => item.headSha === "a".repeat(40))).toBe(true);
      expect(evidence.find((item) => item.scenarioIndex === 1)).toMatchObject({
        exitCode: correct ? 0 : 1,
      });
      expect(evidence.every((item) => /^[a-f0-9]{64}$/.test(item.outputSha256))).toBe(true);
      expect(setup.runner.calls[0]).toMatchObject({
        model: "gpt-6-sol",
        readOnly: true,
        phase: "qa",
      });
      expect(setup.runner.calls[0]?.workdir).not.toBe(setup.workdir);
      const judge = setup.harness.reviewer.calls.at(-1);
      expect(judge?.prompt).toContain('"command"');
      expect(judge?.prompt).toContain('"output"');
      expect(judge?.prompt).toContain('"probe"');
      expect(judge?.prompt).toContain(`\\"actual\\":${correct ? 5 : 0}`);
      expect(judge?.workdir).not.toBe(setup.workdir);
      expect(await readFile(join(setup.workdir, "src/add.ts"), "utf8")).toBe(setup.source);
      expect(await readdir(setup.workdir)).toEqual(["src"]);
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain("import { add }");
      expect(serialized).not.toContain('"actual"');
      for (const unsafe of [
        setup.planted,
        Buffer.from(setup.planted).toString("base64"),
        "UNTRUSTED model claim",
      ])
        expect(serialized).not.toContain(unsafe);
      expect(outcome.costUsd).toBeGreaterThanOrEqual(0.125);
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  },
);

test("model-claimed output without executable probes cannot create trusted evidence", async () => {
  const setup = await fixture(
    true,
    JSON.stringify({
      probes: scenarios.map((item) => ({
        id: item.id,
        command: ["bun", "probe.ts"],
        exitCode: 0,
        output: "passed",
      })),
    }),
  );
  try {
    const outcome = await createDefaultHandlers(setup.harness.deps).qa(setup.context);
    expect(outcome).toMatchObject({
      ok: false,
      failureClass: "factory-tooling",
      costUsd: 0.25,
      model: "gpt-6-sol",
    });
    expect(outcome.summary).toContain("QA probe preparation failed");
    expect(setup.executions).toEqual([]);
    expect(outcome.receipts.filter((receipt) => receipt.kind === "holdout")).toEqual([]);
    expect(setup.harness.reviewer.calls).toEqual([]);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("SHA change after probe planning aborts before any host execution", async () => {
  const setup = await fixture(true);
  try {
    const original = setup.runner.run.bind(setup.runner);
    vi.spyOn(setup.runner, "run").mockImplementation(async (...args) => {
      const result = await original(...args);
      setup.headSha.mockResolvedValue("b".repeat(40));
      return result;
    });
    const outcome = await createDefaultHandlers(setup.harness.deps).qa(setup.context);
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain("QA probe preparation failed");
    expect(setup.executions).toEqual([]);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("failed planner cannot echo private scenarios into workflow feedback", async () => {
  const setup = await fixture(true);
  const privateText = "PRIVATE holdout add(2,3) must return 5";
  const events: string[] = [];
  setup.context.emit = (message) => events.push(message);
  vi.spyOn(setup.runner, "run").mockImplementation(async (request, emit) => {
    emit({ runId: request.runId, at: new Date().toISOString(), kind: "log", message: privateText });
    return {
      runId: request.runId,
      status: "failed",
      summary: privateText,
      receipts: [{ kind: "log", ok: false, summary: privateText }],
    };
  });
  try {
    const outcome = await createDefaultHandlers(setup.harness.deps).qa(setup.context);
    expect(outcome).toMatchObject({ ok: false, failureClass: "factory-tooling" });
    expect(JSON.stringify({ outcome, events })).not.toContain(privateText);
    expect(setup.executions).toEqual([]);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test.each(["failed", "ok", "malformed"])("judge %s diagnostics remain private", async (status) => {
  const setup = await fixture(true);
  const privateText = "PRIVATE scenario and judge rationale";
  const events: string[] = [];
  setup.context.emit = (message) => events.push(message);
  vi.spyOn(setup.harness.reviewer, "run").mockImplementation(async (request, emit) => {
    emit({
      runId: request.runId,
      at: new Date().toISOString(),
      kind: "log",
      message: privateText,
      data: { scenario: privateText },
    });
    return {
      runId: request.runId,
      status: status === "failed" ? "failed" : "ok",
      summary:
        status === "ok"
          ? JSON.stringify({
              verdicts: scenarios.map((item) => ({
                id: item.id,
                satisfied: true,
                reason: privateText,
              })),
            })
          : privateText,
      receipts: [{ kind: "log", ok: false, summary: privateText }],
    };
  });
  try {
    const outcome = await createDefaultHandlers(setup.harness.deps).qa(setup.context);
    const visible = {
      summary: outcome.summary,
      receipts: outcome.receipts.map(publicQaReceipt),
      events,
    };
    expect(JSON.stringify(visible)).not.toContain(privateText);
    expect(JSON.stringify(visible)).not.toContain("./src/add.ts");
    expect(JSON.stringify(visible)).not.toContain("expected");
    expect(outcome.ok).toBe(status === "ok");
    expect(setup.harness.reviewer.run).toHaveBeenCalledTimes(status === "ok" ? 1 : 2);
    if (status !== "ok") expect(outcome.failureClass).toBe("factory-tooling");
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test.each(["finding", "unavailable"])("probe output is withheld on scanner %s", async (failure) => {
  const setup = await fixture(true);
  setup.scanOutput.mockImplementation(async (text) => {
    expect(text).toContain("import { add }");
    expect(text).toContain('"actual"');
    if (failure === "unavailable") throw new Error("scanner unavailable");
    return false;
  });
  try {
    const result = await setup.driver.run(setup.context, {
      scenarios,
      reviewer: { runner: "codex", model: "gpt-6-sol" },
    });
    const receipts = Array.isArray(result) ? result : result.receipts;
    expect(setup.scanOutput).toHaveBeenCalledTimes(4);
    for (const receipt of receipts) {
      const evidence = scenarioEvidence(receipt)!;
      expect(evidence.exitCode).toBe(0);
      expect(evidence.outputSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.probeSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(receipt)).not.toContain('"actual"');
      expect(JSON.stringify(receipt)).not.toContain(setup.planted);
    }
    if (!Array.isArray(result)) {
      expect(
        result.judgeEvidence?.every(
          (item) =>
            item.output.startsWith("output withheld; sha256=") && item.probe === "probe withheld",
        ),
      ).toBe(true);
    }
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test.skipIf(spawnSync("gitleaks", ["version"]).status !== 0)(
  "real gitleaks withholds a committed secret unknown to gateway redaction",
  async () => {
    const committedSecret = ["gh", "p_", "x7Y2kL9pQ4aB6cD8eF1gH3iJ5mN0oP2rS4tU"].join("");
    const plan = JSON.stringify({
      probes: probes.map((probe) => ({
        ...probe,
        source: `${probe.source}\nimport { fixtureSecret } from './src/add.ts'; console.log(fixtureSecret);`,
      })),
    });
    const setup = await fixture(true, plan, committedSecret);
    setup.scanOutput.mockImplementation((text) => scanSecretText(text));
    try {
      const result = await setup.driver.run(setup.context, {
        scenarios,
        reviewer: { runner: "codex", model: "gpt-6-sol" },
      });
      const receipts = Array.isArray(result) ? result : result.receipts;
      expect(receipts).toHaveLength(4);
      expect(JSON.stringify(receipts)).not.toContain(committedSecret);
      for (const receipt of receipts) {
        expect(scenarioEvidence(receipt)).toMatchObject({ exitCode: 0, passed: true });
      }
      if (!Array.isArray(result))
        expect(
          result.judgeEvidence?.every((item) => item.output.startsWith("output withheld; sha256=")),
        ).toBe(true);
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  },
);

test.skipIf(spawnSync("gitleaks", ["version"]).status !== 0)(
  "gitleaks-clean arbitrary committed credential never reaches Store, logs or receipts.json",
  async () => {
    const secret = "fixture-only-arbitrary-credential-qz97";
    const plan = JSON.stringify({
      probes: probes.map((probe) => ({
        ...probe,
        source: `${probe.source}\nimport { fixtureSecret } from './src/add.ts'; console.log(fixtureSecret);`,
      })),
    });
    const setup = await fixture(true, plan, secret);
    setup.scanOutput.mockImplementation((text) => scanSecretText(text));
    const messages: string[] = [];
    let judgePrompt = "";
    setup.context.emit = (message) => messages.push(message);
    try {
      expect(await scanSecretText(secret)).toBe(true);
      vi.spyOn(setup.harness.reviewer, "run").mockImplementation(async (request) => {
        judgePrompt = request.prompt;
        return {
          runId: request.runId,
          status: "ok",
          summary: JSON.stringify({
            verdicts: scenarios.map((item) => ({ id: item.id, satisfied: true, reason: secret })),
          }),
          receipts: [],
        };
      });
      const outcome = await createDefaultHandlers(setup.harness.deps).qa(setup.context);
      expect(outcome.ok).toBe(true);
      expect(judgePrompt).toContain(secret);
      expect(judgePrompt).toContain("import { add }");
      await setup.harness.store.addReceipts(setup.context.runId, outcome.receipts);
      const saved = await setup.harness.store.listReceipts(setup.context.runId);
      const evidence = await nativeQaEvidence(
        {
          listEvents: async () => [],
          getStep: async () => null,
          listReceipts: async () => saved,
        },
        [
          {
            id: setup.context.runId,
            projectId: setup.context.project.id,
            ticketId: setup.context.ticket.id,
            phase: "qa",
            attempt: 0,
            stepKey: "qa-fixture",
            host: "fixture",
            ownerId: "fixture",
            startedAt: new Date(),
            lastEventAt: new Date(),
            heartbeatAt: new Date(),
            status: "ok",
            summary: outcome.summary,
          },
        ],
        nativeQaRedactor([]),
      );
      const path = join(setup.root, "receipts.json");
      await writeNativeQaReceipt(path, evidence, nativeQaRedactor([]));
      for (const artifact of [
        JSON.stringify(outcome),
        JSON.stringify(saved),
        JSON.stringify(messages),
        await readFile(path, "utf8"),
      ]) {
        expect(artifact).not.toContain(secret);
        expect(artifact).not.toContain("import { add }");
        expect(artifact).not.toContain("console.log");
        expect(artifact).not.toContain('"actual"');
      }
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  },
);
