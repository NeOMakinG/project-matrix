import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRunner } from "@matrix/runners";
import {
  asRunToken,
  hostExecutor,
  type LineExecutor,
  PodmanSandbox,
  type ProcessSpec,
} from "@matrix/sandbox";
import { WorktreeGitPort } from "@matrix/workspace";
import { afterEach, expect, test, vi } from "vitest";
import { registerReadOnlyExecutor } from "../../../../packages/sandbox/src/executor-isolation.js";
import { nativeRuntime } from "./native-runtime.js";

vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  freemem: () => 16 * 1024 ** 3,
  loadavg: () => [0, 0, 0],
}));
afterEach(() => vi.restoreAllMocks());

test("handover refusals retain specific redacted reasons in summary and receipt (mock executor)", async () => {
  const key = "planted-gateway-credential-ONLY-TEST";
  vi.spyOn(PodmanSandbox.prototype, "lineExecutor").mockImplementation(
    (policy) => async (_spec, emit) => {
      if (policy.network === "gateway") {
        emit(
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "mock implementation" },
          }),
        );
        emit(
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
        );
      }
      return { exitCode: 0, cancelled: false, timedOut: false, stderrTail: "" };
    },
  );
  vi.spyOn(WorktreeGitPort.prototype, "headSha").mockResolvedValue("a".repeat(40));
  vi.spyOn(WorktreeGitPort.prototype, "commitImplementation").mockRejectedValue(
    new Error(
      `implementation differs from scanned final tree during index refresh ${key} ${Buffer.from(key).toString("base64")} mxr_plantedRunTokenOnlyTest`,
    ),
  );
  const directory = await mkdtemp(join(tmpdir(), "matrix-native-refusal-"));
  const runtime = nativeRuntime({
    workspace: "native",
    dataDir: directory,
    image: "mock-image-not-executed",
    gatewayUrl: "http://127.0.0.1:1",
    gatewayKey: { value: key },
    listModels: async () => ["gpt-6.1-sol"],
  });
  try {
    const result = await runtime.deps.runners.codex!.run(
      {
        runId: "unit",
        projectId: "unit",
        ticketId: "unit",
        phase: "implement",
        runner: "codex",
        model: "gpt-6.1-sol",
        prompt: "unit",
        workdir: directory,
        timeoutMs: 1000,
        env: {},
      },
      () => {},
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    expect(result.summary).toContain(
      "implementation differs from scanned final tree during index refresh",
    );
    expect(result.receipts.at(-1)).toEqual({ kind: "log", ok: false, summary: result.summary });
    for (const secret of [key, Buffer.from(key).toString("base64"), "mxr_plantedRunTokenOnlyTest"])
      expect(JSON.stringify(result)).not.toContain(secret);
  } finally {
    await runtime.broker.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native Codex provider isolates OAuth/config, preserves reviewer model and read-only mounts (mock executor)", async () => {
  const calls: ProcessSpec[] = [];
  vi.spyOn(PodmanSandbox.prototype, "lineExecutor").mockImplementation((policy) =>
    registerReadOnlyExecutor(async (spec, emit) => {
      calls.push(spec);
      if (policy.network === "gateway") {
        emit(
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "mock executor response, not real model QA" },
          }),
        );
        emit(
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
        );
      } else expect(policy.network).toBe("none");
      return { exitCode: 0, cancelled: false, timedOut: false, stderrTail: "" };
    }),
  );
  const directory = await mkdtemp(join(tmpdir(), "matrix-native-adapter-"));
  const runtime = nativeRuntime({
    workspace: "native",
    dataDir: directory,
    image: "mock-image-not-executed",
    gatewayUrl: "http://127.0.0.1:1",
    gatewayKey: { value: "synthetic-unit-test-key-not-real" },
    listModels: async () => ["gpt-6-sol"],
  });
  const runner = runtime.deps.runners.codex!;
  const request = {
    runId: "unit",
    projectId: "unit",
    ticketId: "unit",
    phase: "review" as const,
    runner: "codex" as const,
    model: "gpt-6-sol",
    prompt: "unit",
    workdir: directory,
    timeoutMs: 1000,
    env: {
      CODEX_HOME: "/work/host-auth",
      OPENAI_API_KEY: "must-not-propagate",
      MATRIX_GATEWAY_KEY: "must-not-propagate",
    },
  };
  expect((await runner.run(request, () => {}, new AbortController().signal)).status).toBe("ok");
  expect(calls[0]?.readOnly).toBe(true);
  expect(calls[0]?.env).toEqual({});
  expect(calls[1]?.readOnly).toBe(true);
  expect(calls[1]?.env.CODEX_HOME).toBe("/home/agent");
  expect(calls[1]?.env.OPENAI_API_KEY).toBeUndefined();
  expect(calls[1]?.env.MATRIX_GATEWAY_KEY).toBe("__MATRIX_RUN_TOKEN__");
  expect(calls[1]?.cmd).toContain("gpt-6-sol");
  expect(calls[1]?.cmd).toContain("model_providers.matrix.requires_openai_auth=false");
  await expect(
    runner.run({ ...request, model: "direct-paid-model" }, () => {}, new AbortController().signal),
  ).rejects.toThrow("model direct-paid-model is not served by the gateway");
  await runtime.broker.closeAll();
});
test.each(["undeclared mock", "raw host"])(
  "Codex rejects %s for read-only execution",
  async (kind) => {
    const undeclared = vi.fn<LineExecutor>(async () => ({
      exitCode: 0,
      cancelled: false,
      timedOut: false,
      stderrTail: "",
    }));
    const runner = codexRunner({
      executor: kind === "raw host" ? hostExecutor : undeclared,
      gateway: {
        anthropicBaseUrl: "http://127.0.0.1:1",
        openaiBaseUrl: "http://127.0.0.1:1/v1",
        apiKey: asRunToken("mxr_readonlyfixture"),
      },
    });
    expect(runner.readOnlyIsolation).toBeUndefined();
    await expect(
      runner.run(
        {
          runId: "unit",
          projectId: "unit",
          ticketId: "unit",
          phase: "review",
          runner: "codex",
          model: "gpt-6-sol",
          prompt: "unit",
          workdir: "/unused",
          timeoutMs: 1000,
          readOnly: true,
        },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("executor-enforced OS isolation; host fallback is forbidden");
    expect(undeclared).not.toHaveBeenCalled();
  },
);

test("native runtime wires a sandboxed claude-code runner for any gateway-served model", async () => {
  const calls: ProcessSpec[] = [];
  vi.spyOn(PodmanSandbox.prototype, "lineExecutor").mockImplementation((policy) =>
    registerReadOnlyExecutor(async (spec, emit) => {
      calls.push(spec);
      if (policy.network === "gateway") {
        emit(JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-7" }));
        emit(
          JSON.stringify({
            type: "result",
            subtype: "success",
            result: "spike notes",
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
        );
      } else expect(policy.network).toBe("none");
      return { exitCode: 0, cancelled: false, timedOut: false, stderrTail: "" };
    }),
  );
  const directory = await mkdtemp(join(tmpdir(), "matrix-native-claude-"));
  const runtime = nativeRuntime({
    workspace: "native",
    dataDir: directory,
    image: "mock-image-not-executed",
    gatewayUrl: "http://127.0.0.1:1",
    gatewayKey: { value: "synthetic-unit-test-key-not-real" },
    listModels: async () => ["claude-opus-4-7", "GLM-5.1"],
  });
  try {
    const runner = runtime.deps.runners["claude-code"];
    expect(runner?.id).toBe("claude-code");
    const request = {
      runId: "unit",
      projectId: "unit",
      ticketId: "NEO-7",
      phase: "spike" as const,
      runner: "claude-code" as const,
      model: "claude-opus-4-7",
      prompt: "unit",
      workdir: directory,
      timeoutMs: 1000,
      env: { ANTHROPIC_API_KEY: "must-not-propagate" },
    };
    const result = await runner!.run(request, () => {}, new AbortController().signal);
    expect(result).toMatchObject({ status: "ok", summary: "spike notes" });
    // Preflight asks the image for the `claude` executable, not the runner id.
    expect(calls[0]?.cmd).toContain("claude");
    expect(calls[0]?.cmd).not.toContain("claude-code");
    expect(calls[1]?.readOnly).toBe(true);
    expect(calls[1]?.cmd).toEqual(expect.arrayContaining(["claude", "--model", "claude-opus-4-7"]));
    expect(calls[1]?.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18080",
      ANTHROPIC_AUTH_TOKEN: "__MATRIX_RUN_TOKEN__",
    });
    expect(calls[1]?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[1]?.env.CODEX_HOME).toBeUndefined();
    await expect(
      runner!.run({ ...request, model: "claude-opus-5-5" }, () => {}, new AbortController().signal),
    ).rejects.toThrow("model claude-opus-5-5 is not served by the gateway");
  } finally {
    await runtime.broker.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});
