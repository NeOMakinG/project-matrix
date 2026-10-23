import type { Runner } from "@matrix/core";
import {
  asNumber,
  asRecord,
  asString,
  type CliRunnerDefinition,
  type CliRunnerOptions,
  createCliRunner,
  type EventParser,
  type ParsedEvent,
  type ParseSummary,
  safeJson,
  truncate,
} from "./cli-runner.js";

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Tools that wait, schedule, ask a human or start work that outlives the turn. A headless run has
 * nobody to answer and nothing to wake it: a `ScheduleWakeup` as the last call kept a finished
 * session open until the run timeout. Names checked against Claude Code 2.1.296's init event;
 * unknown names are harmless deny rules, kept so a renamed or re-enabled tool stays blocked.
 */
export const CLAUDE_BASH_MAX_TIMEOUT_MS = 8 * 60_000;

export const CLAUDE_DISALLOWED_TOOLS = [
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "Workflow",
  "Monitor",
  // Subagents can be backgrounded and outlive the turn; the runner is a single agent.
  "Task",
  "Agent",
  "SendMessage",
  "ListAgents",
  "TaskStop",
] as const;

/** Parses `claude -p --output-format stream-json --verbose` output. */
export function claudeCodeParser(): EventParser {
  let result: ParseSummary = { summary: "", isError: false };
  let sawResult = false;
  let lastText = "";
  return {
    onLine(line) {
      const event = safeJson(line);
      if (!event) return [{ kind: "log", message: truncate(line) }];
      const type = asString(event.type);
      const out: ParsedEvent[] = [];
      if (type === "system" && event.subtype === "init") {
        out.push({
          kind: "log",
          message: `session started (model ${asString(event.model) ?? "unknown"})`,
          data: { sessionId: event.session_id },
        });
      } else if (type === "assistant") {
        const content = asRecord(event.message)?.content;
        for (const block of Array.isArray(content) ? content : []) {
          const b = asRecord(block);
          if (!b) continue;
          if (b.type === "text") {
            const text = asString(b.text) ?? "";
            if (text.trim()) {
              lastText = text;
              out.push({ kind: "log", message: truncate(text) });
            }
          } else if (b.type === "tool_use") {
            const name = asString(b.name) ?? "tool";
            const input = asRecord(b.input) ?? {};
            out.push({ kind: "tool", message: name, data: { id: b.id, input } });
            const path = asString(input.file_path) ?? asString(input.notebook_path);
            if (FILE_TOOLS.has(name) && path)
              out.push({ kind: "file", message: path, data: { tool: name } });
          }
        }
      } else if (type === "user") {
        const content = asRecord(event.message)?.content;
        for (const block of Array.isArray(content) ? content : []) {
          const b = asRecord(block);
          if (b?.type === "tool_result" && b.is_error === true) {
            const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
            out.push({
              kind: "error",
              message: truncate(`tool error: ${text}`),
              data: { toolUseId: b.tool_use_id },
            });
          }
        }
      } else if (type === "rate_limit_event") {
        out.push({ kind: "log", message: "rate limit event", data: event.rate_limit_info });
      } else if (type === "result") {
        sawResult = true;
        const usage = asRecord(event.usage);
        const input =
          (asNumber(usage?.input_tokens) ?? 0) +
          (asNumber(usage?.cache_read_input_tokens) ?? 0) +
          (asNumber(usage?.cache_creation_input_tokens) ?? 0);
        const output = asNumber(usage?.output_tokens) ?? 0;
        const costUsd = asNumber(event.total_cost_usd);
        const isError =
          event.is_error === true || (asString(event.subtype) ?? "success") !== "success";
        result = {
          summary:
            asString(event.result) ?? (isError ? `claude-code ${String(event.subtype)}` : lastText),
          isError,
          ...(usage ? { tokens: { input, output } } : {}),
          ...(costUsd !== undefined ? { costUsd } : {}),
        };
        out.push({
          kind: "cost",
          message: `${input} in / ${output} out${costUsd !== undefined ? ` / $${costUsd.toFixed(4)}` : ""}`,
          data: { input, output, costUsd, turns: event.num_turns },
        });
        if (isError) out.push({ kind: "error", message: truncate(result.summary) });
      }
      return out;
    },
    isComplete: () => sawResult,
    finish() {
      if (!sawResult)
        return { summary: lastText || "no result event from claude-code", isError: true };
      return result;
    },
  };
}

export const claudeCodeDefinition: CliRunnerDefinition = {
  id: "claude-code",
  defaultBinary: "claude",
  command(req, opts) {
    const cmd = [
      opts.binary ?? "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      req.model,
      // No MCP servers from user/project config: only what the runner passes explicitly (none).
      "--strict-mcp-config",
      // One comma-separated value: the flag is variadic and would swallow following arguments.
      "--disallowedTools",
      CLAUDE_DISALLOWED_TOOLS.join(","),
    ];
    if (opts.skipPermissions) cmd.push("--dangerously-skip-permissions");
    return {
      cmd,
      stdin: req.prompt,
      env: {
        ANTHROPIC_BASE_URL: opts.gateway.anthropicBaseUrl,
        // Bearer auth to the gateway (the broker swaps the run token for the real key).
        ANTHROPIC_AUTH_TOKEN: opts.gateway.apiKey,
        // Background/subagent calls use the same served model, never an id the gateway lacks.
        ANTHROPIC_SMALL_FAST_MODEL: req.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: req.model,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        // No `run_in_background` Bash, no auto-backgrounding: every command finishes in the turn.
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        // One Bash call (default cap 10 min) must fit inside the runner's 10-min idle limit.
        BASH_MAX_TIMEOUT_MS: String(CLAUDE_BASH_MAX_TIMEOUT_MS),
      },
    };
  },
  parser: claudeCodeParser,
};

export function claudeCodeRunner(options: CliRunnerOptions): Runner {
  return createCliRunner(claudeCodeDefinition, options);
}
