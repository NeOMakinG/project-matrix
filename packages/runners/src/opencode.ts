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

const FILE_TOOLS = new Set(["write", "edit", "patch", "multiedit"]);

/** Parses `opencode run --format json`. Unknown event types are ignored. */
export function opencodeParser(): EventParser {
  let text = "";
  let input = 0;
  let output = 0;
  let cost = 0;
  let sawStep = false;
  let failure: string | undefined;
  return {
    onLine(line) {
      const event = safeJson(line);
      if (!event) return [{ kind: "log", message: truncate(line) }];
      const type = asString(event.type);
      const part = asRecord(event.part) ?? {};
      const out: ParsedEvent[] = [];
      if (type === "text") {
        const chunk = asString(part.text) ?? "";
        if (chunk.trim()) {
          text = chunk;
          out.push({ kind: "log", message: truncate(chunk) });
        }
      } else if (type === "tool_use") {
        const tool = asString(part.tool) ?? "tool";
        const state = asRecord(part.state) ?? {};
        const toolInput = asRecord(state.input) ?? {};
        const status = asString(state.status);
        out.push({
          kind: status === "error" ? "error" : "tool",
          message:
            status === "error"
              ? `${tool} failed: ${truncate(asString(state.error) ?? "", 500)}`
              : tool,
          data: { input: toolInput },
        });
        const path =
          asString(toolInput.filePath) ?? asString(toolInput.file_path) ?? asString(toolInput.path);
        if (FILE_TOOLS.has(tool) && path) out.push({ kind: "file", message: path, data: { tool } });
      } else if (type === "step_finish") {
        sawStep = true;
        const tokens = asRecord(part.tokens) ?? {};
        const cache = asRecord(tokens.cache) ?? {};
        input +=
          (asNumber(tokens.input) ?? 0) +
          (asNumber(cache.read) ?? 0) +
          (asNumber(cache.write) ?? 0);
        output += (asNumber(tokens.output) ?? 0) + (asNumber(tokens.reasoning) ?? 0);
        cost += asNumber(part.cost) ?? 0;
        out.push({
          kind: "cost",
          message: `${input} in / ${output} out`,
          data: { input, output, costUsd: cost },
        });
      } else if (type === "error") {
        const error = asRecord(event.error);
        failure =
          asString(asRecord(error?.data)?.message) ??
          asString(error?.message) ??
          asString(event.message) ??
          "opencode error";
        out.push({ kind: "error", message: truncate(failure) });
      }
      return out;
    },
    finish() {
      return {
        summary: failure ?? text,
        isError: failure !== undefined || (!sawStep && !text),
        ...(sawStep ? { tokens: { input, output }, costUsd: cost } : {}),
      };
    },
  };
}

export const opencodeDefinition: CliRunnerDefinition = {
  id: "opencode",
  defaultBinary: "opencode",
  command(req, opts) {
    const config = {
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      share: "disabled",
      provider: {
        matrix: {
          npm: "@ai-sdk/openai-compatible",
          name: "matrix",
          options: { baseURL: opts.gateway.openaiBaseUrl, apiKey: "{env:MATRIX_GATEWAY_KEY}" },
          models: { [req.model]: {} },
        },
      },
      ...(opts.skipPermissions
        ? { permission: { edit: "allow", bash: "allow", webfetch: "deny" } }
        : {}),
    };
    return {
      cmd: [
        opts.binary ?? "opencode",
        "run",
        "--format",
        "json",
        "-m",
        `matrix/${req.model}`,
        req.prompt,
      ],
      env: {
        MATRIX_GATEWAY_KEY: opts.gateway.apiKey,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
    };
  },
  parser: opencodeParser,
};

export function opencodeRunner(options: CliRunnerOptions): Runner {
  return createCliRunner(opencodeDefinition, options);
}
