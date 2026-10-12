import { delay } from "msw";
import { sse } from "msw/sse";

const TAIL = [
  { kind: "log", message: "agent-browser: checkout annual plan, test card 4242 → success page" },
  { kind: "tool", message: "curl POST /api/checkout → 200 (412 ms)" },
  { kind: "file", message: "Uploading receipts to ticket MX-142" },
] as const;

/** Browser-only: msw cannot build SSE handlers where EventSource is missing. */
export const sseHandlers = [
  sse<{ ready: string; log: string; tool: string; file: string }>(
    "*/v1/runs/:id/events",
    async ({ client, params }) => {
      const runId = String(params.id);
      client.send({ event: "ready", data: JSON.stringify({ runId }) });
      for (const [i, e] of TAIL.entries()) {
        await delay(800);
        const event = { runId, at: `2026-10-12T11:0${i}:00Z`, ...e };
        client.send({ id: String(i + 1), event: e.kind, data: JSON.stringify(event) });
        // duplicate on purpose: the client must de-duplicate
        if (i === 1) client.send({ id: String(i + 1), event: e.kind, data: JSON.stringify(event) });
      }
    },
  ),
];
