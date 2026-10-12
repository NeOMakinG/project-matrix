import type { ChatRequest, LlmClient } from "./ports.js";

export interface GatewayOptions {
  /** OpenAI-compatible base URL, e.g. the CLIProxyAPI gateway `http://host:8317/v1`. */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * OpenAI-compatible chat completion through the CLIProxyAPI gateway.
 * temperature 0 + fixed seed keep triage as deterministic as the provider allows.
 */
export class GatewayLlm implements LlmClient {
  constructor(private readonly opts: GatewayOptions) {}

  async complete(req: ChatRequest): Promise<string> {
    this.opts.signal?.throwIfAborted();
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        temperature: 0,
        seed: 7,
        max_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
      signal: AbortSignal.any([
        AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
        ...(this.opts.signal ? [this.opts.signal] : []),
      ]),
    });
    this.opts.signal?.throwIfAborted();
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`gateway ${res.status}: ${text}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    this.opts.signal?.throwIfAborted();
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("gateway returned an empty completion");
    return content;
  }
}

/** Extracts the first JSON object from a completion (tolerates ```json fences and prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in completion");
  return JSON.parse(candidate.slice(start, end + 1));
}
