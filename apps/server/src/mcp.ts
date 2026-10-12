import { PHASES } from "@matrix/core";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { HttpError, type Principal } from "./auth/guard.js";
import * as S from "./http/schemas.js";
import type { Operations } from "./ops.js";

const phase = z.enum(PHASES);
// Same limits as the REST schemas (http/schemas.ts), so MCP can't send what REST would reject.
const id = z.string().min(1).max(200);
const autonomy = z.enum(["human", "gated", "autonomous"]);
const status = z.enum([
  "open",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "qa",
  "done",
  "closed",
]);

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

async function result(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    // Only our own errors are shown; anything else is logged and reported generically.
    if (!(error instanceof HttpError)) console.error("mcp tool error", error);
    const message =
      error instanceof HttpError
        ? `${error.status} ${error.code}: ${error.message}`
        : "500 internal: internal error";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** Builds an MCP server bound to one authenticated key; every tool goes through the same Operations guard as REST. */
export function buildMcpServer(ops: Operations, p: Principal): McpServer {
  const server = new McpServer({ name: "project-matrix", version: "0.1.0" });

  server.registerTool(
    "list_projects",
    { description: "List projects visible to this API key.", annotations: { readOnlyHint: true } },
    () => result(() => ops.listProjects(p)),
  );
  server.registerTool(
    "get_project",
    {
      description: "Get a project with its autonomy settings.",
      inputSchema: { projectId: id },
      annotations: { readOnlyHint: true },
    },
    ({ projectId }) => result(() => ops.getProject(p, projectId)),
  );
  server.registerTool(
    "list_tickets",
    {
      description: "List tickets of a project, optionally filtered by status or labels.",
      inputSchema: {
        projectId: id,
        status: z.array(status).optional(),
        labels: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ projectId, status: s, labels }) =>
      result(() =>
        ops.listTickets(p, projectId, {
          ...(s ? { status: s } : {}),
          ...(labels ? { labels } : {}),
        }),
      ),
  );
  server.registerTool(
    "create_ticket",
    {
      description: "Create a ticket in the project's ticket system.",
      inputSchema: { projectId: id, ...S.CreateTicket.shape },
    },
    ({ projectId, title, body, labels, priority, parent, deps }) =>
      result(() =>
        ops.createTicket(p, projectId, {
          title,
          body,
          ...(labels ? { labels } : {}),
          ...(priority === undefined ? {} : { priority }),
          ...(parent ? { parent } : {}),
          ...(deps ? { deps } : {}),
        }),
      ),
  );
  server.registerTool(
    "update_ticket",
    {
      description: "Update a ticket's status, labels, title or body.",
      inputSchema: { projectId: id, ticketId: id, ...S.UpdateTicket.shape },
    },
    ({ projectId, ticketId, ...patch }) =>
      result(() =>
        ops.updateTicket(
          p,
          projectId,
          ticketId,
          Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
        ),
      ),
  );
  server.registerTool(
    "list_runs",
    {
      description: "List runs, optionally for one project.",
      inputSchema: { projectId: id.optional() },
      annotations: { readOnlyHint: true },
    },
    ({ projectId }) => result(() => ops.listRuns(p, projectId)),
  );
  server.registerTool(
    "get_run",
    {
      description: "Get one run with its state and cost.",
      inputSchema: { runId: id },
      annotations: { readOnlyHint: true },
    },
    ({ runId }) => result(() => ops.getRun(p, runId)),
  );
  server.registerTool(
    "start_run",
    {
      description: "Start a loop phase for a ticket.",
      inputSchema: { projectId: id, ticketId: id, phase },
    },
    (input) => result(() => ops.startRun(p, input)),
  );
  server.registerTool(
    "pause_run",
    { description: "Pause a queued or running run.", inputSchema: { runId: id } },
    ({ runId }) => result(() => ops.pauseRun(p, runId)),
  );
  server.registerTool(
    "cancel_run",
    {
      description: "Cancel a run.",
      inputSchema: { runId: id },
      annotations: { destructiveHint: true },
    },
    ({ runId }) => result(() => ops.cancelRun(p, runId)),
  );
  server.registerTool(
    "list_receipts",
    {
      description: "List the QA, review and test receipts of a run.",
      inputSchema: { runId: id },
      annotations: { readOnlyHint: true },
    },
    ({ runId }) => result(() => ops.listReceipts(p, runId)),
  );
  server.registerTool(
    "list_approvals",
    {
      description: "List approvals, e.g. pending merge or deploy decisions.",
      inputSchema: { projectId: id.optional(), status: S.ApprovalStatus.optional() },
      annotations: { readOnlyHint: true },
    },
    ({ projectId, status }) =>
      result(() =>
        ops.listApprovals(p, {
          ...(projectId ? { projectId } : {}),
          ...(status ? { status } : {}),
        }),
      ),
  );
  server.registerTool(
    "decide_approval",
    {
      description:
        "Approve or reject a pending approval. Requesters, reconcilers and the run's owner can't decide.",
      inputSchema: { approvalId: id, ...S.ApprovalDecisionInput.shape },
    },
    ({ approvalId, decision, note }) =>
      result(() => ops.decideApproval(p, approvalId, decision, note)),
  );
  server.registerTool(
    "merge_run",
    {
      description: "Merge a run's branch, subject to the project's autonomy setting.",
      inputSchema: { runId: id },
    },
    ({ runId }) => result(() => ops.merge(p, runId)),
  );
  server.registerTool(
    "deploy_project",
    {
      description: "Deploy a project.",
      inputSchema: { projectId: id },
      annotations: { destructiveHint: true },
    },
    ({ projectId }) => result(() => ops.deploy(p, projectId)),
  );
  server.registerTool(
    "set_autonomy",
    {
      description: "Set the autonomy mode of one loop phase for a project.",
      inputSchema: { projectId: id, phase, mode: autonomy },
    },
    ({ projectId, phase: ph, mode }) => result(() => ops.setAutonomy(p, projectId, ph, mode)),
  );
  server.registerTool(
    "list_adrs",
    {
      description: "List the project's ADRs and their rules.",
      inputSchema: { projectId: id },
      annotations: { readOnlyHint: true },
    },
    ({ projectId }) => result(() => ops.listAdrs(p, projectId)),
  );
  server.registerTool(
    "get_product_graph",
    {
      description: "Get the product graph: goals, features, ADRs, tickets and modules.",
      inputSchema: { projectId: id },
      annotations: { readOnlyHint: true },
    },
    ({ projectId }) => result(() => ops.getGraph(p, projectId)),
  );
  server.registerTool(
    "start_init",
    {
      description: "Start an init interview session for a project.",
      inputSchema: { projectId: id },
    },
    ({ projectId }) => result(() => ops.startInit(p, projectId)),
  );
  server.registerTool(
    "answer_init",
    {
      description: "Submit answers to an init interview session.",
      inputSchema: { sessionId: id, ...S.InitAnswers.shape },
    },
    ({ sessionId, answers }) => result(() => ops.answerInit(p, sessionId, answers)),
  );

  server.registerTool(
    "init_progress",
    {
      description:
        "Current interview round: every answerable question with kind, options, recommendation and rationale, plus contradictions.",
      inputSchema: { sessionId: id },
      annotations: { readOnlyHint: true },
    },
    ({ sessionId }) => result(() => ops.getInitProgress(p, sessionId)),
  );
  server.registerTool(
    "finalize_init",
    {
      description:
        "Generate the project from the interview answers (config, ADRs, CONTEXT.md, product graph, scaffold, backlog). Idempotent.",
      inputSchema: { sessionId: id, acceptRecommended: z.boolean().optional() },
    },
    ({ sessionId, acceptRecommended }) =>
      result(() =>
        ops.finalizeInit(p, sessionId, { acceptRecommended: acceptRecommended === true }),
      ),
  );

  server.registerResource(
    "project-adrs",
    new ResourceTemplate("matrix://projects/{projectId}/adrs", { list: undefined }),
    { description: "ADRs of a project", mimeType: "application/json" },
    async (uri, { projectId }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await ops.listAdrs(p, String(projectId))),
        },
      ],
    }),
  );
  server.registerResource(
    "project-graph",
    new ResourceTemplate("matrix://projects/{projectId}/graph", { list: undefined }),
    { description: "Product graph of a project", mimeType: "application/json" },
    async (uri, { projectId }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await ops.getGraph(p, String(projectId))),
        },
      ],
    }),
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request, bound to the request's key. */
export async function handleMcp(
  ops: Operations,
  p: Principal,
  request: Request,
): Promise<Response> {
  const server = buildMcpServer(ops, p);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // No sessionIdGenerator: stateless mode, one transport per request.
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}
