import type { StackFrame } from "./signal.js";

/** Code-graph hint for a stack frame or suspected location (backed by @matrix/graph queries). */
export interface GraphHint {
  path: string;
  symbol?: string;
  reason: string;
  adrs: string[];
  features: string[];
  /** True when the code graph confirms the path exists in the repository. */
  inRepo: boolean;
}

export interface GraphPort {
  hintsFor(input: {
    projectId: string;
    frames: StackFrame[];
    title: string;
    exceptionType?: string;
  }): Promise<GraphHint[]>;
}

/** Fallback when no code graph is available: in-app frames become hints, no ADR/feature links. */
export const framesOnlyGraph: GraphPort = {
  async hintsFor({ frames }) {
    const seen = new Set<string>();
    const hints: GraphHint[] = [];
    for (const f of frames) {
      if (!f.inApp || seen.has(f.file)) continue;
      seen.add(f.file);
      const hint: GraphHint = {
        path: f.file,
        reason: `stack frame${f.line !== undefined ? ` at line ${f.line}` : ""}`,
        adrs: [],
        features: [],
        // Unverified: without a code graph we can't tell a real path from a forged frame.
        inRepo: false,
      };
      if (f.function) hint.symbol = f.function;
      hints.push(hint);
      if (hints.length === 5) break;
    }
    return hints;
  },
};

export interface Deployment {
  release: string;
  deployedAt: string;
  environment?: string;
}

/** Port: deployment history, used for regression detection and the verify window. */
export interface ReleasePort {
  deployments(projectId: string): Promise<Deployment[]>;
}

export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}

/** Port: an LLM completion (OpenAI-compatible gateway in production, fake in tests). */
export interface LlmClient {
  complete(req: ChatRequest): Promise<string>;
}

export interface Notification {
  projectId: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  body: string;
  url?: string;
}

/** Port: human notifications (Telegram, email, …). */
export interface Notifier {
  notify(n: Notification): Promise<void>;
}
