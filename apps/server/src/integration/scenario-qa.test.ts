import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultHandlers,
  type HoldoutScenario,
  type PhaseContext,
  type Receipt,
  type Sandbox,
  scenarioEvidence,
} from "@matrix/core";
import { createHarness, FakeRunner } from "@matrix/core/testing";
import { expect, test, vi } from "vitest";
import { scenarioQaDriver } from "./scenario-qa.js";

const scenarios: HoldoutScenario[] = [
  { id: "s1", given: "zero operands", when: "add(0,0)", then: "returns 0" },
  { id: "s2", given: "positive operands", when: "add(2,3)", then: "returns 5" },
  { id: "s3", given: "negative operand", when: "add(-2,1)", then: "returns -1" },
  {
    id: "s4",
    given: "unchanged state",
    when: "repeated add(2,3)",
    then: "same sum and no side effects",
  },
];
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
      'import { add } from "./src/add.ts";\nconst before = Object.keys(globalThis).sort().join(",");\nconst sums = Array.from({length: 5}, () => add(2, 3));\nconsole.log(JSON.stringify({ sums }));\nif (sums.some(sum => sum !== 5) || before !== Object.keys(globalThis).sort().join(",")) throw new Error("side effect or inconsistent sum");\n',
  },
];

async function fixture(correct: boolean, plan = JSON.stringify({ probes })) {
  const root = await mkdtemp(join(tmpdir(), "matrix-qa-probes-"));
  const workdir = join(root, "worktree");
  const source = `export function add(left: number, right: number): number { return ${correct ? "left + right" : "0"}; }\n`;
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
  });
  harness.deps.qa = driver;
  return { root, source, workdir, context, harness, driver, runner, executions, headSha, planted };
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
      expect(evidence.find((item) => item.id === "s2")).toMatchObject({
        exitCode: correct ? 0 : 1,
      });
      expect(evidence.find((item) => item.id === "s2")?.output).toContain(
        `"actual":${correct ? 5 : 0}`,
      );
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
      expect(judge?.workdir).not.toBe(setup.workdir);
      expect(await readFile(join(setup.workdir, "src/add.ts"), "utf8")).toBe(setup.source);
      expect(await readdir(setup.workdir)).toEqual(["src"]);
      const serialized = JSON.stringify(outcome);
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
    expect(outcome).toMatchObject({ ok: false, failureClass: "factory-tooling", costUsd: 0.125 });
    expect(outcome.summary).toContain("model-claimed evidence is not trusted");
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
    expect(outcome.summary).toContain("committed SHA changed");
    expect(setup.executions).toEqual([]);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});
