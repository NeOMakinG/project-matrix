import { z } from "@hono/zod-openapi";
import type { RunEvent } from "@matrix/core";
import { streamSSE } from "hono/streaming";
import type { Operations } from "../ops.js";
import { type App, IdParam, route } from "./route.js";
import * as S from "./schemas.js";

export function runRoutes(app: App, ops: Operations) {
  app.openapi(
    route({
      method: "get",
      path: "/v1/runs",
      tag: "runs",
      summary: "List runs",
      query: z.object({ projectId: z.string().optional() }),
      response: z.array(S.Run),
    }),
    async (c) => c.json(await ops.listRuns(c.var.principal, c.req.valid("query").projectId)),
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/runs",
      tag: "runs",
      summary: "Start a loop phase for a ticket",
      body: S.StartRun,
      response: S.Run,
    }),
    async (c) => c.json(await ops.startRun(c.var.principal, c.req.valid("json"))),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/runs/{id}",
      tag: "runs",
      summary: "Get a run",
      params: IdParam,
      response: S.Run,
    }),
    async (c) => c.json(await ops.getRun(c.var.principal, c.req.valid("param").id)),
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/runs/{id}/pause",
      tag: "runs",
      summary: "Pause a run",
      params: IdParam,
      response: S.Run,
    }),
    async (c) => c.json(await ops.pauseRun(c.var.principal, c.req.valid("param").id)),
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/runs/{id}/cancel",
      tag: "runs",
      summary: "Cancel a run",
      params: IdParam,
      response: S.Run,
    }),
    async (c) => c.json(await ops.cancelRun(c.var.principal, c.req.valid("param").id)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/runs/{id}/receipts",
      tag: "runs",
      summary: "List a run's receipts",
      params: IdParam,
      response: z.array(S.Receipt),
    }),
    async (c) => c.json(await ops.listReceipts(c.var.principal, c.req.valid("param").id)),
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/runs/{id}/approval",
      tag: "runs",
      summary: "Approve a run or request changes",
      params: IdParam,
      body: S.ApprovalInput,
      response: S.Approval,
    }),
    async (c) => {
      const { decision, comment } = c.req.valid("json");
      return c.json(await ops.approve(c.var.principal, c.req.valid("param").id, decision, comment));
    },
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/runs/{id}/merge",
      tag: "runs",
      summary: "Merge a run's branch (respects autonomy)",
      params: IdParam,
      response: S.Run,
    }),
    async (c) => c.json(await ops.merge(c.var.principal, c.req.valid("param").id)),
  );

  // Server-sent events: not described in OpenAPI because the payload is a stream of RunEvent JSON objects.
  app.get("/v1/runs/:id/events", async (c) => {
    const runId = c.req.param("id");
    await ops.authorizeRunStream(c.var.principal, runId);
    return streamSSE(c, async (stream) => {
      const queue: RunEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = ops.core.subscribe(runId, (event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ runId }) });
      while (!stream.aborted) {
        const event = queue.shift();
        if (event) {
          await stream.writeSSE({ event: event.kind, data: JSON.stringify(event) });
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 15_000);
        });
        wake = undefined;
        if (queue.length === 0 && !stream.aborted)
          await stream.writeSSE({ event: "ping", data: "" });
      }
      unsubscribe();
    });
  });
}
