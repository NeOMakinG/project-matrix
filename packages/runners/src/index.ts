import type { Runner, RunnerId } from "@matrix/core";
import { claudeCodeRunner } from "./claude-code.js";
import type { CliRunnerOptions } from "./cli-runner.js";
import { type CodexOptions, codexRunner } from "./codex.js";
import { opencodeRunner } from "./opencode.js";

export const name = "@matrix/runners";

export * from "./claude-code.js";
export * from "./cli-runner.js";
export * from "./codex.js";
export * from "./opencode.js";

export function createRunner(id: RunnerId, options: CliRunnerOptions & CodexOptions): Runner {
  switch (id) {
    case "claude-code":
      return claudeCodeRunner(options);
    case "codex":
      return codexRunner(options);
    case "opencode":
      return opencodeRunner(options);
  }
}
