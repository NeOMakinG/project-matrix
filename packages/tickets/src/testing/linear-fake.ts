import type { FetchLike } from "../adapters/linear-client.js";
import type { LinearIssue, LinearState } from "../adapters/linear-queries.js";

/** In-memory Linear GraphQL fake covering the operations LinearTicketStore sends. */
export interface FakeLinear {
  fetch: FetchLike;
  issues: Map<string, LinearIssue>;
  states: LinearState[];
  calls: Array<{ op: string; variables: Record<string, unknown>; auth: string }>;
  /** Responses to serve before normal handling (e.g. 429s). */
  queue: Array<{ status: number; body: unknown; headers?: Record<string, string> }>;
  pageSize: number;
  /** Comments by id (body + owning issue uuid). */
  comments: Map<string, { issueId: string; body: string }>;
}

const STATES: Array<[string, string]> = [
  ["Backlog", "backlog"],
  ["Todo", "unstarted"],
  ["Ready", "unstarted"],
  ["Spike", "started"],
  ["Implement", "started"],
  ["Review", "started"],
  ["QA", "started"],
  ["Awaiting merge", "started"],
  ["Done", "completed"],
  ["Canceled", "canceled"],
  ["Duplicate", "canceled"],
];

export function fakeLinear(teamKey = "NEO"): FakeLinear {
  const team = { id: "team-1", key: teamKey };
  const states = STATES.map(([name, type], i) => ({ id: `state-${i}`, name, type }));
  const labels = new Map<string, { id: string; name: string; team: { id: string } | null }>();
  const relations: Array<{ id: string; type: string; from: string; to: string }> = [];
  const issues = new Map<string, LinearIssue>();
  const byUuid = (id: string) =>
    [...issues.values()].find((i) => i.id === id || i.identifier === id);
  let seq = 0;
  const fake: FakeLinear = {
    fetch: undefined as never,
    issues,
    states,
    calls: [],
    queue: [],
    pageSize: 2,
    comments: new Map(),
  };

  const view = (issue: LinearIssue): LinearIssue => ({
    ...issue,
    inverseRelations: {
      nodes: relations
        .filter((r) => r.to === issue.id)
        .map((r) => {
          const src = byUuid(r.from) as LinearIssue;
          return {
            id: r.id,
            type: r.type,
            issue: { identifier: src.identifier, state: { type: src.state.type } },
          };
        }),
    },
  });
  const apply = (issue: LinearIssue, input: Record<string, unknown>) => {
    if (typeof input.title === "string") issue.title = input.title;
    if (typeof input.description === "string") issue.description = input.description;
    if (typeof input.priority === "number") issue.priority = input.priority;
    if (typeof input.stateId === "string")
      issue.state = states.find((s) => s.id === input.stateId) as LinearState;
    if (Array.isArray(input.labelIds))
      issue.labels.nodes = [...labels.values()]
        .filter((l) => (input.labelIds as string[]).includes(l.id))
        .map((l) => ({ id: l.id, name: l.name }));
    if (typeof input.parentId === "string")
      issue.parent = { identifier: (byUuid(input.parentId) as LinearIssue).identifier };
    if (typeof input.assigneeId === "string")
      issue.assignee = { name: "ada", displayName: "ada", email: "ada@example.com" };
    issue.updatedAt = new Date().toISOString();
  };

  const matchesFilter = (i: LinearIssue, f: Record<string, any>) =>
    i.team.key === f.team?.key?.eq &&
    i.labels.nodes.some((l) => l.name === f.labels?.some?.name?.eq) &&
    (!f.state || i.state.name.toLowerCase() === String(f.state.name.eqIgnoreCase).toLowerCase());

  const handle = (op: string, v: Record<string, any>): unknown => {
    switch (op) {
      case "MatrixTeam":
        return {
          teams: { nodes: v.key === team.key ? [{ ...team, states: { nodes: states } }] : [] },
        };
      case "MatrixIssues": {
        const all = [...issues.values()].filter((i) => matchesFilter(i, v.filter));
        const start = v.after ? Number(v.after) : 0;
        const page = all.slice(start, start + fake.pageSize);
        const next = start + fake.pageSize < all.length;
        return {
          issues: {
            nodes: page.map(view),
            pageInfo: { hasNextPage: next, endCursor: next ? String(start + fake.pageSize) : null },
          },
        };
      }
      case "MatrixIssue": {
        const issue = byUuid(v.id);
        if (!issue) throw Object.assign(new Error("Entity not found: Issue"), { gql: true });
        return { issue: view(issue) };
      }
      case "MatrixLabels":
        return {
          issueLabels: {
            nodes: [...labels.values()].filter((l) => v.names.includes(l.name)),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      case "MatrixLabelCreate": {
        const label = { id: `label-${++seq}`, name: v.input.name, team: { id: v.input.teamId } };
        labels.set(label.id, label);
        return { issueLabelCreate: { success: true, issueLabel: label } };
      }
      case "MatrixIssueCreate": {
        const n = issues.size + 1;
        const now = new Date().toISOString();
        const issue: LinearIssue = {
          id: `uuid-${n}`,
          identifier: `${team.key}-${n}`,
          title: "",
          description: "",
          url: `https://linear.app/x/issue/${team.key}-${n}`,
          createdAt: now,
          updatedAt: now,
          priority: 0,
          state: states[0] as LinearState,
          team,
          labels: { nodes: [] },
          assignee: null,
          parent: null,
          inverseRelations: { nodes: [] },
        };
        apply(issue, v.input);
        issues.set(issue.identifier, issue);
        return { issueCreate: { success: true, issue: view(issue) } };
      }
      case "MatrixIssueUpdate": {
        const issue = byUuid(v.id) as LinearIssue;
        apply(issue, v.input);
        return { issueUpdate: { success: true, issue: view(issue) } };
      }
      case "MatrixComment": {
        const id = `comment-${++seq}`;
        fake.comments.set(id, { issueId: v.input.issueId, body: v.input.body });
        return { commentCreate: { success: true, comment: { id } } };
      }
      case "MatrixCommentUpdate": {
        const comment = fake.comments.get(v.id);
        if (!comment) throw new Error("Entity not found: Comment");
        comment.body = v.input.body;
        return { commentUpdate: { success: true } };
      }
      case "MatrixRelation":
        relations.push({
          id: `rel-${++seq}`,
          type: v.input.type,
          from: v.input.issueId,
          to: v.input.relatedIssueId,
        });
        return { issueRelationCreate: { success: true } };
      case "MatrixRelationDelete":
        relations.splice(
          relations.findIndex((r) => r.id === v.id),
          1,
        );
        return { issueRelationDelete: { success: true } };
      case "MatrixUsers":
        return { users: { nodes: v.q === "ada" ? [{ id: "user-1" }] : [] } };
      default:
        throw new Error(`fake linear: unknown op ${op}`);
    }
  };

  const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });

  fake.fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    fake.calls.push({ op, variables, auth: init.headers.Authorization ?? "" });
    const queued = fake.queue.shift();
    if (queued) return respond(queued.status, queued.body, queued.headers);
    try {
      return respond(200, { data: handle(op, variables as Record<string, any>) });
    } catch (error) {
      return respond(200, { data: null, errors: [{ message: (error as Error).message }] });
    }
  };
  return fake;
}
