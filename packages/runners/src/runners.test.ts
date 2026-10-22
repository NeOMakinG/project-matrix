import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunRequest } from "@matrix/core";
import {
  asRunToken,
  BwrapSandbox,
  CredentialBroker,
  hostExecutor,
  isReadOnlyExecutor,
  type LineExecutor,
  type ProcessSpec,
} from "@matrix/sandbox";
import { describe, expect, test } from "vitest";
import { claudeCodeRunner, codexRunner, createRunner, opencodeRunner } from "./index";

const gateway = {
  anthropicBaseUrl: "http://127.0.0.1:18080",
  openaiBaseUrl: "http://127.0.0.1:18080/v1",
  apiKey: asRunToken("mxr_test123"),
};

describe("Figma MCP configuration", () => {
  test("host capture policy binds capability without forwarding remote tools or credentials", async () => {
    const { executor, calls } = fakeExecutor(['{"type":"turn.completed"}']);
    const runner = codexRunner({
      gateway,
      executor,
      figmaMcp: {
        serverName: "figma",
        url: "https://mcp.figma.com/mcp",
        policySha256: "a".repeat(64),
        hostCaptureOnly: true,
      },
    });
    await runner.run({ ...req, runner: "codex" }, () => {}, new AbortController().signal);
    expect(runner.figmaMcp?.policySha256).toBe("a".repeat(64));
    expect(calls[0]!.cmd.join(" ")).not.toContain("mcp_servers.figma");
    expect(calls[0]!.env).not.toHaveProperty("Authorization");
  });
  test("Codex exposes the exact configured MCP capability and passes it through config overrides", async () => {
    const { executor, calls } = fakeExecutor([
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
      '{"type":"turn.completed"}',
    ]);
    const runner = codexRunner({
      gateway,
      executor,
      figmaMcp: { serverName: "figma", url: "https://mcp.figma.com/mcp" },
    });
    expect(runner.figmaMcp).toMatchObject({
      serverName: "figma",
      url: "https://mcp.figma.com/mcp",
      configurationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await runner.run(
      { ...req, runner: "codex", model: "gpt-5.6-sol" },
      () => {},
      new AbortController().signal,
    );
    expect(calls[0]?.cmd).toContain('mcp_servers.figma.url="https://mcp.figma.com/mcp"');
    expect(codexRunner({ gateway, executor }).figmaMcp).toBeUndefined();
    expect(
      opencodeRunner({
        gateway,
        executor,
        figmaMcp: { serverName: "figma", url: "https://mcp.figma.com/mcp" },
      }).figmaMcp,
    ).toBeUndefined();
  });
  test.each([
    { serverName: "figma.url", url: "https://mcp.figma.com/mcp" },
    { serverName: "figma", url: "https://secret@mcp.figma.com/mcp" },
    { serverName: "figma", url: "https://mcp.figma.com/mcp?token=secret" },
    { serverName: "figma", url: "http://mcp.figma.com/mcp" },
  ])("rejects unsafe or secret-bearing configuration %j", (figmaMcp) => {
    expect(() => codexRunner({ gateway, figmaMcp })).toThrow("invalid Figma MCP configuration");
  });
});

const req: RunRequest = {
  runId: "r1",
  projectId: "p1",
  ticketId: "t1",
  phase: "implement",
  runner: "claude-code",
  model: "claude-fable-5-1",
  prompt: "do the thing",
  workdir: "/work",
  timeoutMs: 60_000,
};

function fakeExecutor(
  lines: string[],
  exitCode = 0,
  extra: Partial<{ timedOut: boolean; cancelled: boolean }> = {},
) {
  const calls: ProcessSpec[] = [];
  const executor: LineExecutor = async (spec, onLine) => {
    calls.push(spec);
    for (const line of lines) onLine(line);
    return { exitCode, timedOut: false, cancelled: false, stderrTail: "boom", ...extra };
  };
  return { executor, calls };
}

const claudeLines = [
  JSON.stringify({ type: "system", subtype: "hook_started", hook_id: "h" }),
  JSON.stringify({ type: "system", subtype: "init", model: "claude-fable-5-1", session_id: "s1" }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Editing the file" },
        { type: "tool_use", id: "tu1", name: "Edit", input: { file_path: "src/a.ts" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "nope" }],
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done",
    total_cost_usd: 0.5,
    num_turns: 2,
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 1,
      output_tokens: 20,
    },
  }),
];

describe("claude-code runner", () => {
  test("builds a headless command routed to the gateway with the run token only", async () => {
    const { executor, calls } = fakeExecutor(claudeLines);
    const runner = claudeCodeRunner({
      gateway,
      executor,
      skipPermissions: true,
      baseEnv: { PATH: "/usr/bin" },
    });
    await runner.run(req, () => {}, new AbortController().signal);
    const call = calls[0];
    expect(call?.cmd).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-fable-5-1",
      "--dangerously-skip-permissions",
    ]);
    expect(call?.stdin).toBe("do the thing");
    expect(call?.env).toMatchObject({
      PATH: "/usr/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18080",
      ANTHROPIC_AUTH_TOKEN: "mxr_test123",
    });
    expect(call?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(call?.env).toMatchObject({
      ANTHROPIC_SMALL_FAST_MODEL: "claude-fable-5-1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-fable-5-1",
    });
    expect(Object.keys(call?.env ?? {})).not.toContain("HOME");
  });

  test("maps stream-json events, tokens and cost", async () => {
    const { executor } = fakeExecutor(claudeLines);
    const events: RunEvent[] = [];
    const result = await claudeCodeRunner({ gateway, executor }).run(
      req,
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "ok",
      summary: "Done",
      tokens: { input: 16, output: 20 },
      costUsd: 0.5,
    });
    expect(events.map((e) => e.kind)).toEqual([
      "log",
      "log",
      "tool",
      "file",
      "error",
      "cost",
      "done",
    ]);
    expect(events.find((e) => e.kind === "file")?.message).toBe("src/a.ts");
  });

  test("missing result event is a failure", async () => {
    const { executor } = fakeExecutor(claudeLines.slice(0, 3));
    const result = await claudeCodeRunner({ gateway, executor }).run(
      req,
      () => {},
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
  });

  test("timeout and cancellation map to statuses", async () => {
    const timed = fakeExecutor(claudeLines, -1, { timedOut: true });
    expect(
      (
        await claudeCodeRunner({ gateway, executor: timed.executor }).run(
          req,
          () => {},
          new AbortController().signal,
        )
      ).status,
    ).toBe("timeout");
    const cancelled = fakeExecutor([], -1, { cancelled: true });
    expect(
      (
        await claudeCodeRunner({ gateway, executor: cancelled.executor }).run(
          req,
          () => {},
          new AbortController().signal,
        )
      ).status,
    ).toBe("cancelled");
  });

  test("writes a transcript receipt with sha256", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-runner-"));
    const { executor } = fakeExecutor(claudeLines);
    const result = await claudeCodeRunner({
      gateway,
      executor,
      transcriptPath: (r) => join(dir, `${r.runId}.jsonl`),
    }).run(req, () => {}, new AbortController().signal);
    const receipt = result.receipts[0];
    expect(receipt?.kind).toBe("log");
    expect(receipt?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(dir, "r1.jsonl"), "utf8")).toContain('"type":"result"');
  });
});

describe("codex runner", () => {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "th" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.started",
      item: { id: "i0", type: "command_execution", command: "ls" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "i0",
        type: "command_execution",
        command: "ls",
        aggregated_output: "a",
        exit_code: 0,
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "i1", type: "file_change", changes: [{ path: "x.ts", kind: "update" }] },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "i2", type: "agent_message", text: "All done" },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 4 },
    }),
  ];

  test("command uses the matrix provider and stdin prompt", async () => {
    const { executor, calls } = fakeExecutor(lines);
    await codexRunner({ gateway, executor }).run(
      { ...req, runner: "codex", model: "gpt-6.1-sol" },
      () => {},
      new AbortController().signal,
    );
    const call = calls[0];
    expect(call?.cmd).toContain("exec");
    expect(call?.cmd).toContain('model_provider="matrix"');
    expect(call?.cmd).toContain('model_providers.matrix.base_url="http://127.0.0.1:18080/v1"');
    expect(call?.cmd).toContain("model_providers.matrix.requires_openai_auth=false");
    expect(call?.cmd).toContain('cli_auth_credentials_store="file"');
    expect(call?.cmd).toContain("workspace-write");
    expect(call?.cmd.at(-1)).toBe("-");
    expect(call?.env.MATRIX_GATEWAY_KEY).toBe("mxr_test123");
  });

  test("parses items and usage", async () => {
    const { executor } = fakeExecutor(lines);
    const events: RunEvent[] = [];
    const result = await codexRunner({ gateway, executor }).run(
      req,
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "ok",
      summary: "All done",
      tokens: { input: 10, output: 4 },
    });
    expect(events.filter((e) => e.kind === "file").map((e) => e.message)).toEqual(["x.ts"]);
  });

  test("turn.failed is a failure", async () => {
    const { executor } = fakeExecutor([
      JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } }),
    ]);
    const result = await codexRunner({ gateway, executor }).run(
      req,
      () => {},
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("rate limited");
  });
});

describe("opencode runner", () => {
  test("injects provider config and parses steps", async () => {
    const { executor, calls } = fakeExecutor([
      JSON.stringify({ type: "step_start", part: {} }),
      JSON.stringify({
        type: "tool_use",
        part: { tool: "edit", state: { status: "completed", input: { filePath: "y.ts" } } },
      }),
      JSON.stringify({ type: "text", part: { text: "Finished" } }),
      JSON.stringify({
        type: "step_finish",
        part: {
          tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 1, write: 0 } },
          cost: 0.01,
        },
      }),
    ]);
    const events: RunEvent[] = [];
    const result = await opencodeRunner({ gateway, executor }).run(
      { ...req, runner: "opencode", model: "GLM-5.3" },
      (e) => events.push(e),
      new AbortController().signal,
    );
    const config = JSON.parse(calls[0]?.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(config.provider.matrix.options.baseURL).toBe("http://127.0.0.1:18080/v1");
    expect(JSON.stringify(config)).not.toContain("mxr_test123");
    expect(calls[0]?.cmd).toContain("matrix/GLM-5.3");
    expect(result).toMatchObject({
      status: "ok",
      summary: "Finished",
      tokens: { input: 4, output: 3 },
      costUsd: 0.01,
    });
    expect(events.some((e) => e.kind === "file" && e.message === "y.ts")).toBe(true);
  });
});

test("createRunner dispatches by id", () => {
  expect(createRunner("codex", { gateway }).id).toBe("codex");
  expect(createRunner("opencode", { gateway }).id).toBe("opencode");
  expect(createRunner("claude-code", { gateway }).id).toBe("claude-code");
});

test("unisolated readOnly requests fail before invoking the executor", async () => {
  const { executor, calls } = fakeExecutor(claudeLines);
  await expect(
    claudeCodeRunner({ gateway, executor }).run(
      { ...req, readOnly: true },
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("OS isolation");
  expect(calls).toHaveLength(0);
});

test.each([false, true])(
  "design cannot run on the host/fake executor, readOnly=%s",
  async (readOnly) => {
    const { executor, calls } = fakeExecutor([]);
    for (const selected of [executor, undefined]) {
      const runner = codexRunner({
        gateway,
        ...(selected ? { executor: selected } : {}),
        skipPermissions: true,
      });
      expect(runner.readOnlyIsolation).toBeUndefined();
      await expect(
        runner.run(
          { ...req, runner: "codex", phase: "design", readOnly },
          () => {},
          new AbortController().signal,
        ),
      ).rejects.toThrow("OS isolation");
    }
    expect(calls).toHaveLength(0);
    expect(isReadOnlyExecutor(hostExecutor)).toBe(false);
  },
);

test.each([false, true])(
  "isolated design uses OS read-only mount and never CLI bypass (readOnly=%s)",
  async (readOnly) => {
    const { executor, calls } = fakeExecutor(['{"type":"turn.completed"}']);
    const sandbox = new BwrapSandbox({
      executor,
      broker: new CredentialBroker({
        gatewayUrl: gateway.openaiBaseUrl,
        gatewayKey: { value: "test-only-not-a-real-key" },
      }),
    });
    const runner = codexRunner({
      gateway,
      executor: sandbox.lineExecutor({ runId: "readonly-test", network: "none" }),
      skipPermissions: true,
    });
    expect(runner.readOnlyIsolation).toBe("os");
    await runner.run(
      { ...req, runner: "codex", phase: "design", readOnly },
      () => {},
      new AbortController().signal,
    );
    const command = calls[0]!.cmd;
    expect(command).toContain("--ro-bind");
    expect(command).toContain("read-only");
    expect(command).not.toContain("workspace-write");
    expect(command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  },
);

test("a plain string can't be passed as the gateway apiKey", () => {
  // @ts-expect-error real keys are plain strings, not RunToken
  const bad: Parameters<typeof claudeCodeRunner>[0]["gateway"]["apiKey"] = "sk-real-key";
  expect(bad).toBe("sk-real-key");
  expect(() => asRunToken("sk-real-key")).toThrow();
});
