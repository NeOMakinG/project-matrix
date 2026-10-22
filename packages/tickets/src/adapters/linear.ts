import type {
  LinkType,
  NewTicket,
  Ticket,
  TicketPatch,
  TicketQuery,
  TicketStatus,
  TicketStore,
  TrackerPhase,
} from "../types.js";
import { matches } from "./beads.js";
import { LinearApiError, LinearClient, type LinearClientOptions } from "./linear-client.js";
import {
  columnFor,
  DEFAULT_PHASE_COLUMNS,
  DEFAULT_STATE_NAMES,
  isCommentKey,
  isTerminal,
  type LinearPhaseColumns,
  type LinearStateNames,
  openBlockers,
  readBody,
  toLinearPriority,
  toTicket,
  writeBody,
} from "./linear-mapping.js";
import * as Q from "./linear-queries.js";

export { LinearApiError, sanitizeUntrusted } from "./linear-client.js";

export interface LinearStoreOptions extends LinearClientOptions {
  /** Linear team key, e.g. `NEO`. */
  teamKey: string;
  /** Label scoping a Matrix project inside the team, e.g. `project:travel-journal`. */
  projectLabel: string;
  /** Workflow state that makes an issue eligible for pickup. Default `Ready`. */
  readyState?: string;
  /** Override target state names per Matrix status. */
  states?: Partial<LinearStateNames>;
  /** Override the board column per Matrix phase (see `DEFAULT_PHASE_COLUMNS`). */
  phaseColumns?: LinearPhaseColumns;
}

const norm = (s: string) => s.trim().toLowerCase();
/** Coarse statuses the reconciler sets at phase start; with a phase they map to its column. */
const PHASED = new Set<TicketStatus>(["in_progress", "review", "qa"]);

interface Team {
  id: string;
  key: string;
  states: Map<string, Q.LinearState>;
}

/** TicketStore over Linear issues of one team, scoped to one project label. */
export class LinearTicketStore implements TicketStore {
  readonly kind = "linear" as const;
  readonly #client: LinearClient;
  readonly #teamKey: string;
  readonly #label: string;
  readonly #names: LinearStateNames;
  readonly #phases: LinearPhaseColumns;
  #team: Promise<Team> | undefined;

  constructor(options: LinearStoreOptions) {
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(options.teamKey))
      throw new Error(`invalid Linear team key ${JSON.stringify(options.teamKey)}`);
    if (!options.projectLabel.trim() || options.projectLabel.length > 80)
      throw new Error("Linear projectLabel must be a non-empty label name");
    this.#client = new LinearClient(options);
    this.#teamKey = options.teamKey;
    this.#label = options.projectLabel;
    this.#names = {
      ...DEFAULT_STATE_NAMES,
      ...options.states,
      ...(options.readyState ? { ready: options.readyState } : {}),
    };
    this.#phases = { ...DEFAULT_PHASE_COLUMNS, ...options.phaseColumns };
  }

  #idOk(id: string): boolean {
    const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(id);
    return m?.[1] === this.#teamKey;
  }

  #inScope(issue: Q.LinearIssue): boolean {
    return (
      issue.team.key === this.#teamKey && issue.labels.nodes.some((l) => l.name === this.#label)
    );
  }

  #loadTeam(): Promise<Team> {
    this.#team ??= (async () => {
      const data = await this.#client.request<{
        teams: { nodes: Array<{ id: string; key: string; states: { nodes: Q.LinearState[] } }> };
      }>(Q.TEAM, { key: this.#teamKey });
      const team = data.teams.nodes.find((t) => t.key === this.#teamKey);
      if (!team) throw new LinearApiError(`Linear team ${this.#teamKey} not found`);
      const states = new Map(team.states.nodes.map((s) => [s.name.trim().toLowerCase(), s]));
      return { id: team.id, key: team.key, states };
    })().catch((error) => {
      this.#team = undefined;
      throw error;
    });
    return this.#team;
  }

  #stateId(status: Exclude<TicketStatus, "blocked">): Promise<string> {
    return this.#stateIdByName(this.#names[status]);
  }

  async #stateIdByName(name: string): Promise<string> {
    const state = (await this.#loadTeam()).states.get(norm(name));
    if (!state)
      throw new LinearApiError(`Linear state "${name}" not found in team ${this.#teamKey}`);
    return state.id;
  }

  async #issues(extra: Record<string, unknown> = {}): Promise<Q.LinearIssue[]> {
    const filter = {
      team: { key: { eq: this.#teamKey } },
      labels: { some: { name: { eq: this.#label } } },
      ...extra,
    };
    const out: Q.LinearIssue[] = [];
    let after: string | null = null;
    for (let page = 0; page < 100; page++) {
      const data: { issues: { nodes: Q.LinearIssue[]; pageInfo: Q.PageInfo } } =
        await this.#client.request(Q.LIST_ISSUES, { filter, after });
      out.push(...data.issues.nodes);
      if (!data.issues.pageInfo.hasNextPage) return out.filter((i) => this.#inScope(i));
      after = data.issues.pageInfo.endCursor;
      if (!after) throw new LinearApiError("Linear pagination returned no cursor");
    }
    throw new LinearApiError("Linear pagination exceeded 10000 issues");
  }

  async #issue(id: string): Promise<Q.LinearIssue | null> {
    if (!this.#idOk(id)) return null;
    try {
      const data = await this.#client.request<{ issue: Q.LinearIssue | null }>(Q.GET_ISSUE, { id });
      return data.issue && this.#inScope(data.issue) ? data.issue : null;
    } catch (error) {
      if (error instanceof LinearApiError && /not found|entity not found/i.test(error.message))
        return null;
      throw error;
    }
  }

  async #must(id: string): Promise<Q.LinearIssue> {
    const issue = await this.#issue(id);
    if (!issue) throw new Error(`ticket ${id} not found`);
    return issue;
  }

  async list(query: TicketQuery = {}): Promise<Ticket[]> {
    return (await this.#issues())
      .map((i) => toTicket(i, this.#names))
      .filter((t) => matches(t, query));
  }

  async get(id: string): Promise<Ticket | null> {
    const issue = await this.#issue(id);
    return issue ? toTicket(issue, this.#names) : null;
  }

  async ready(): Promise<Ticket[]> {
    const issues = await this.#issues({ state: { name: { eqIgnoreCase: this.#names.ready } } });
    return issues
      .filter((i) => i.state.name.trim().toLowerCase() === this.#names.ready.trim().toLowerCase())
      .filter((i) => !readBody(i.description).meta.blocked)
      .filter((i) => openBlockers(i).length === 0)
      .map((i) => ({ ...toTicket(i, this.#names), status: "ready" as const }));
  }
  /** Resolves label names to ids (team or workspace labels), creating missing ones on the team. */
  async #labelIds(names: string[]): Promise<string[]> {
    const wanted = [...new Set(names)];
    if (wanted.length === 0) return [];
    const team = await this.#loadTeam();
    const found = new Map<string, string>();
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const data: {
        issueLabels: {
          nodes: Array<{ id: string; name: string; team: { id: string } | null }>;
          pageInfo: Q.PageInfo;
        };
      } = await this.#client.request(Q.LABELS, { names: wanted, after });
      for (const l of data.issueLabels.nodes) {
        if (l.team && l.team.id !== team.id) continue;
        // Team labels win over workspace labels with the same name.
        if (!found.has(l.name) || l.team) found.set(l.name, l.id);
      }
      if (!data.issueLabels.pageInfo.hasNextPage) break;
      after = data.issueLabels.pageInfo.endCursor;
    }
    for (const name of wanted) {
      if (found.has(name)) continue;
      const data = await this.#client.request<{
        issueLabelCreate: { success: boolean; issueLabel: { id: string } | null };
      }>(Q.CREATE_LABEL, { input: { name, teamId: team.id } });
      if (!data.issueLabelCreate.success || !data.issueLabelCreate.issueLabel)
        throw new LinearApiError(`could not create Linear label ${JSON.stringify(name)}`);
      found.set(name, data.issueLabelCreate.issueLabel.id);
    }
    return wanted.map((n) => found.get(n) as string);
  }

  async #userId(who: string): Promise<string> {
    const data = await this.#client.request<{ users: { nodes: Array<{ id: string }> } }>(Q.USERS, {
      q: who,
    });
    const [user, other] = data.users.nodes;
    if (!user || other)
      throw new Error(`Linear user ${JSON.stringify(who)} not found or ambiguous`);
    return user.id;
  }

  async create(input: NewTicket): Promise<Ticket> {
    const team = await this.#loadTeam();
    const labelIds = await this.#labelIds([this.#label, ...(input.labels ?? [])]);
    const parent = input.parent ? await this.#must(input.parent) : undefined;
    // Resolve deps up front so a stale id fails before anything is created in Linear.
    for (const dep of input.deps ?? []) await this.#must(dep);
    const data = await this.#client.request<{
      issueCreate: { success: boolean; issue: Q.LinearIssue | null };
    }>(Q.CREATE_ISSUE, {
      input: {
        teamId: team.id,
        title: input.title,
        description: writeBody(input.body, {}),
        labelIds,
        stateId: await this.#stateId("open"),
        ...(input.priority !== undefined ? { priority: toLinearPriority(input.priority) } : {}),
        ...(parent ? { parentId: parent.id } : {}),
      },
    });
    const issue = data.issueCreate.issue;
    if (!data.issueCreate.success || !issue) throw new LinearApiError("Linear issueCreate failed");
    for (const dep of input.deps ?? []) await this.link(dep, issue.identifier, "blocks");
    return (await this.get(issue.identifier)) ?? toTicket(issue, this.#names);
  }

  async update(id: string, patch: TicketPatch): Promise<Ticket> {
    const issue = await this.#must(id);
    const { text, meta } = readBody(issue.description);
    if (patch.phase !== undefined) meta.phase = patch.phase;
    if (patch.status !== undefined) meta.blocked = patch.status === "blocked";
    const input: Record<string, unknown> = {
      description: writeBody(patch.body ?? text, meta),
    };
    if (patch.title !== undefined) input.title = patch.title;
    if (patch.priority !== undefined) input.priority = toLinearPriority(patch.priority);
    // "blocked" keeps the current column; the flag lives in the body block.
    if (patch.status !== undefined && patch.status !== "blocked") {
      const column =
        patch.phase !== undefined && PHASED.has(patch.status)
          ? columnFor({ phase: patch.phase, status: "running" }, this.#names, this.#phases)
          : undefined;
      input.stateId = column
        ? await this.#stateIdByName(column)
        : await this.#stateId(patch.status);
    }
    if (patch.labels !== undefined)
      input.labelIds = await this.#labelIds([this.#label, ...patch.labels]);
    if (patch.assignee !== undefined) input.assigneeId = await this.#userId(patch.assignee);
    if (patch.parent !== undefined) input.parentId = (await this.#must(patch.parent)).id;
    const data = await this.#client.request<{
      issueUpdate: { success: boolean; issue: Q.LinearIssue | null };
    }>(Q.UPDATE_ISSUE, { id: issue.id, input });
    if (!data.issueUpdate.success) throw new LinearApiError(`Linear issueUpdate ${id} failed`);
    if (patch.deps !== undefined) await this.#syncDeps(issue, patch.deps);
    const updated = await this.get(id);
    if (!updated) throw new Error(`ticket ${id} vanished after update`);
    return updated;
  }

  async #syncDeps(issue: Q.LinearIssue, deps: string[]): Promise<void> {
    const current = issue.inverseRelations.nodes.filter((r) => r.type === "blocks");
    for (const r of current)
      if (!deps.includes(r.issue.identifier))
        await this.#client.request(Q.DELETE_RELATION, { id: r.id });
    const have = new Set(current.map((r) => r.issue.identifier));
    for (const dep of deps) if (!have.has(dep)) await this.link(dep, issue.identifier, "blocks");
  }

  async comment(id: string, body: string): Promise<void> {
    await this.#createComment(await this.#must(id), body);
  }

  async #createComment(issue: Q.LinearIssue, body: string): Promise<string> {
    const data = await this.#client.request<{
      commentCreate: { success: boolean; comment: { id: string } | null };
    }>(Q.CREATE_COMMENT, { input: { issueId: issue.id, body } });
    if (!data.commentCreate.success || !data.commentCreate.comment)
      throw new LinearApiError(`Linear comment on ${issue.identifier} failed`);
    return data.commentCreate.comment.id;
  }

  /** Moves the issue to the column of a workflow phase; never reopens a finished issue. */
  async setPhase(id: string, position: TrackerPhase): Promise<void> {
    const column = columnFor(position, this.#names, this.#phases);
    if (!column) return;
    const issue = await this.#must(id);
    if (norm(issue.state.name) === norm(column)) return;
    // A human closed or canceled it while Matrix worked: leave it there.
    if (isTerminal(issue.state.type)) return;
    const data = await this.#client.request<{ issueUpdate: { success: boolean } }>(Q.UPDATE_ISSUE, {
      id: issue.id,
      input: { stateId: await this.#stateIdByName(column) },
    });
    if (!data.issueUpdate.success) throw new LinearApiError(`Linear move of ${id} failed`);
  }

  /**
   * One live comment per `key`: created once, then edited in place. Its id rides in the hidden
   * Matrix block of the issue description; a deleted comment is recreated.
   */
  async upsertComment(id: string, key: string, body: string): Promise<void> {
    if (!isCommentKey(key)) throw new Error(`invalid comment key ${JSON.stringify(key)}`);
    const issue = await this.#must(id);
    const { text, meta } = readBody(issue.description);
    const existing = meta.comments?.[key];
    if (existing) {
      try {
        const data = await this.#client.request<{ commentUpdate: { success: boolean } }>(
          Q.UPDATE_COMMENT,
          { id: existing, input: { body } },
        );
        if (data.commentUpdate.success) return;
      } catch (error) {
        if (!(error instanceof LinearApiError && /not found/i.test(error.message))) throw error;
      }
    }
    const commentId = await this.#createComment(issue, body);
    meta.comments = { ...meta.comments, [key]: commentId };
    const data = await this.#client.request<{ issueUpdate: { success: boolean } }>(Q.UPDATE_ISSUE, {
      id: issue.id,
      input: { description: writeBody(text, meta) },
    });
    if (!data.issueUpdate.success) throw new LinearApiError(`Linear issueUpdate ${id} failed`);
  }

  /** Makes sure the project label exists on the team (created when missing). */
  async ensureScope(): Promise<void> {
    await this.#labelIds([this.#label]);
  }

  /** `from blocks to`, `from is parent of to`, or `from related to` (same as other adapters). */
  async link(from: string, to: string, type: LinkType): Promise<void> {
    const [source, target] = [await this.#must(from), await this.#must(to)];
    if (type === "parent") {
      const data = await this.#client.request<{ issueUpdate: { success: boolean } }>(
        Q.UPDATE_ISSUE,
        { id: target.id, input: { parentId: source.id } },
      );
      if (!data.issueUpdate.success) throw new LinearApiError(`Linear parent link ${to} failed`);
      return;
    }
    if (
      type === "blocks" &&
      target.inverseRelations.nodes.some(
        (r) => r.type === "blocks" && r.issue.identifier === source.identifier,
      )
    )
      return;
    const data = await this.#client.request<{ issueRelationCreate: { success: boolean } }>(
      Q.CREATE_RELATION,
      { input: { issueId: source.id, relatedIssueId: target.id, type } },
    );
    if (!data.issueRelationCreate.success)
      throw new LinearApiError(`Linear relation ${from} -> ${to} failed`);
  }
}
