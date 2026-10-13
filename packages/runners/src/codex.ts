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
  safeJson,
  truncate,
} from "./cli-runner.js";

/** Parses `codex exec --json` JSONL output. */
export function codexParser(): EventParser {
  let lastMessage = "";
  let input = 0;
  let output = 0;
  let sawUsage = false;
  let failure: string | undefined;
  let completed = false;
  return {
    onLine(line) {
      const event = safeJson(line);
      if (!event) return [{ kind: "log", message: truncate(line) }];
      const type = asString(event.type);
      const out: ParsedEvent[] = [];
      if (type === "thread.started") {
        out.push({
          kind: "log",
          message: "codex session started",
          data: { threadId: event.thread_id },
        });
      } else if (type === "item.completed" || type === "item.started") {
        const item = asRecord(event.item);
        const itemType = asString(item?.type);
        if (!item || !itemType) return out;
        if (type === "item.started") {
          if (itemType === "command_execution") {
            out.push({
              kind: "tool",
              message: `shell: ${truncate(asString(item.command) ?? "", 500)}`,
            });
          }
          return out;
        }
        if (itemType === "agent_message") {
          lastMessage = asString(item.text) ?? lastMessage;
          if (lastMessage.trim()) out.push({ kind: "log", message: truncate(lastMessage) });
        } else if (itemType === "command_execution") {
          const exitCode = asNumber(item.exit_code);
          out.push({
            kind: exitCode !== undefined && exitCode !== 0 ? "error" : "tool",
            message: `shell exit ${exitCode ?? "?"}: ${truncate(asString(item.command) ?? "", 500)}`,
            data: { output: truncate(asString(item.aggregated_output) ?? "", 2000) },
          });
        } else if (itemType === "file_change") {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          for (const change of changes) {
            const c = asRecord(change);
            const path = asString(c?.path);
            if (path) out.push({ kind: "file", message: path, data: { change: c?.kind } });
          }
        } else if (itemType === "mcp_tool_call") {
          out.push({
            kind: "tool",
            message: `${asString(item.server) ?? "mcp"}.${asString(item.tool) ?? "tool"}`,
          });
        } else if (itemType === "error") {
          out.push({
            kind: "error",
            message: truncate(asString(item.message) ?? "codex item error"),
          });
        }
      } else if (type === "turn.completed") {
        completed = true;
        const usage = asRecord(event.usage);
        if (usage) {
          sawUsage = true;
          input += (asNumber(usage.input_tokens) ?? 0) + (asNumber(usage.cached_input_tokens) ?? 0);
          output += asNumber(usage.output_tokens) ?? 0;
          out.push({
            kind: "cost",
            message: `${input} in / ${output} out`,
            data: { input, output },
          });
        }
      } else if (type === "turn.failed" || type === "error") {
        failure =
          asString(asRecord(event.error)?.message) ??
          asString(event.message) ??
          "codex turn failed";
        out.push({ kind: "error", message: truncate(failure) });
      }
      return out;
    },
    finish() {
      const isError = failure !== undefined || !completed;
      return {
        summary: failure ?? (lastMessage || (completed ? "" : "codex produced no completed turn")),
        isError,
        ...(sawUsage ? { tokens: { input, output } } : {}),
      };
    },
  };
}

export interface CodexOptions extends CliRunnerOptions {
  /** Wire protocol the gateway speaks for OpenAI-style models. */
  wireApi?: "responses" | "chat";
}

export function codexDefinition(wireApi: "responses" | "chat"): CliRunnerDefinition {
  return {
    id: "codex",
    supportsFigmaMcp: true,
    defaultBinary: "codex",
    command(req, opts) {
      const cmd = [
        opts.binary ?? "codex",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-C",
        req.workdir,
        "-m",
        req.model,
        "-c",
        'model_provider="matrix"',
        "-c",
        'model_providers.matrix.name="matrix"',
        "-c",
        `model_providers.matrix.base_url=${JSON.stringify(opts.gateway.openaiBaseUrl)}`,
        "-c",
        'model_providers.matrix.env_key="MATRIX_GATEWAY_KEY"',
        "-c",
        `model_providers.matrix.wire_api="${wireApi}"`,
      ];
      if (opts.figmaMcp && !opts.figmaMcp.hostCaptureOnly) {
        cmd.push(
          "-c",
          `mcp_servers.${opts.figmaMcp.serverName}.url=${JSON.stringify(opts.figmaMcp.url)}`,
        );
      }
      cmd.push(
        ...(req.readOnly || req.phase === "design"
          ? ["-s", "read-only"]
          : opts.skipPermissions
            ? ["--dangerously-bypass-approvals-and-sandbox"]
            : ["-s", "workspace-write"]),
      );
      cmd.push("-");
      return { cmd, stdin: req.prompt, env: { MATRIX_GATEWAY_KEY: opts.gateway.apiKey } };
    },
    parser: codexParser,
  };
}

export function codexRunner(options: CodexOptions): Runner {
  return createCliRunner(codexDefinition(options.wireApi ?? "responses"), options);
}
