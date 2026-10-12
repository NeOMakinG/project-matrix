import { z } from "@hono/zod-openapi";
import type { RunEvent } from "@matrix/core";
import { streamSSE } from "hono/streaming";
import type { KeyStore } from "../auth/keys.js";
import type { Operations } from "../ops.js";
import { type App, IdParam, route } from "./route.js";
import * as S from "./schemas.js";

const MAX_QUEUED_EVENTS = 1000;

export function runRoutes(app: App, ops: Operations, keys: KeyStore) {
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
      method: "get",
      path: "/v1/approvals",
      tag: "approvals",
      summary: "List approvals",
      query: z.object({ projectId: z.string().optional(), status: S.ApprovalStatus.optional() }),
      response: z.array(S.Approval),
    }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json(
        await ops.listApprovals(c.var.principal, {
          ...(q.projectId ? { projectId: q.projectId } : {}),
          ...(q.status ? { status: q.status } : {}),
        }),
      );
    },
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/approvals/{id}/decision",
      tag: "approvals",
      summary: "Approve or reject a pending approval",
      params: IdParam,
      body: S.ApprovalDecisionInput,
      response: S.Approval,
    }),
    async (c) => {
      const { decision, note } = c.req.valid("json");
      return c.json(
        await ops.decideApproval(c.var.principal, c.req.valid("param").id, decision, note),
      );
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
  // The stream closes when the key is revoked, and when a slow client lets the queue overflow.
  app.get("/v1/runs/:id/events", async (c) => {
    const runId = c.req.param("id");
    const principal = c.var.principal;
    await ops.authorizeRunStream(principal, runId);
    return streamSSE(c, async (stream) => {
      const queue: RunEvent[] = [];
      let closed: string | undefined;
      let wake: (() => void) | undefined;
      const close = (reason: string) => {
        closed ??= reason;
        wake?.();
      };
      const unsubscribe = ops.core.subscribe(runId, (event) => {
        if (queue.length >= MAX_QUEUED_EVENTS) return close("overflow");
        queue.push(event);
        wake?.();
      });
      const stopRevoke = keys.onRevoke((id) => {
        if (id === principal.key.id) close("revoked");
      });
      stream.onAbort(() => close("aborted"));
      try {
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ runId }) });
        while (!closed && !stream.aborted) {
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
          if (!keys.isActive(principal.key.id)) close("revoked");
          if (!closed && queue.length === 0 && !stream.aborted) {
            await stream.writeSSE({ event: "ping", data: "" });
          }
        }
        if (closed && closed !== "aborted" && !stream.aborted) {
          await stream.writeSSE({ event: "close", data: JSON.stringify({ reason: closed }) });
        }
      } finally {
        unsubscribe();
        stopRevoke();
      }
    });
  });
}
