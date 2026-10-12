import createFetchClient from "openapi-fetch";
import type { components, paths } from "./schema.js";

export const name = "@matrix/sdk";

export type { components, paths };
export type Schemas = components["schemas"];
export type Project = Schemas["Project"];
export type Ticket = Schemas["Ticket"];
export type Run = Schemas["Run"];
export type Receipt = Schemas["Receipt"];
export type ApiKey = Schemas["ApiKey"];

export interface MatrixClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export interface RunStreamEvent {
  event: string;
  data: unknown;
}

/** Typed REST client generated from the server's OpenAPI document, plus SSE and MCP helpers. */
export function createMatrixClient(options: MatrixClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = { authorization: `Bearer ${options.apiKey}` };

  const api = createFetchClient<paths>({ baseUrl, headers, fetch: fetcher });

  /** Async iterator over a run's server-sent events. Abort the signal to stop. */
  async function* runEvents(runId: string, signal?: AbortSignal): AsyncGenerator<RunStreamEvent> {
    const response = await fetcher(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: { ...headers, accept: "text/event-stream" },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok || !response.body) {
      throw new Error(`run events: HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
          const raw = /^data: (.*)$/m.exec(block)?.[1] ?? "";
          if (event !== "ping") {
            let data: unknown = raw;
            try {
              data = raw ? JSON.parse(raw) : null;
            } catch {
              // keep raw text
            }
            yield { event, data };
          }
          index = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  return {
    api,
    runEvents,
    /** Streamable HTTP MCP endpoint and headers, for MCP clients and agent configs. */
    mcp: { url: `${baseUrl}/mcp`, headers },
  };
}

export type MatrixClient = ReturnType<typeof createMatrixClient>;
