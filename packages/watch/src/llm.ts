import type { z } from "zod";
import type { Fetch } from "./types.js";

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

export function extractJsonBlock(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

/**
 * One OpenAI-compatible chat call (CLIProxyAPI) validated against a Zod schema. Temperature 0;
 * retries once with the validation error appended. The API key is only sent in the header.
 */
export async function completeJson<S extends z.ZodType>(
  gateway: GatewayConfig,
  system: string,
  user: string,
  schema: S,
): Promise<z.infer<S>> {
  const f = gateway.fetch ?? fetch;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), gateway.timeoutMs ?? 120_000);
    try {
      const res = await f(`${gateway.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${gateway.apiKey}` },
        body: JSON.stringify({
          model: gateway.model,
          temperature: 0,
          max_tokens: 8000,
          messages: lastError
            ? [
                ...messages,
                {
                  role: "user",
                  content: `Your previous answer was invalid: ${lastError}. Reply with JSON only.`,
                },
              ]
            : messages,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`gateway ${res.status}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = schema.safeParse(extractJsonBlock(content));
      if (parsed.success) return parsed.data;
      lastError = parsed.error.message.slice(0, 500);
    } catch (error) {
      lastError = (error as Error).message;
      if (/gateway (401|403)/.test(lastError)) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`LLM call failed: ${lastError}`);
}
