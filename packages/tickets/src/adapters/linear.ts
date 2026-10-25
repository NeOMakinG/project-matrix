import { sanitizeUntrusted } from "../sanitize.js";
import {
  type LinkType,
  MATRIX_COMMENT_MARKER,
  NEEDS_HUMAN_LABEL,
  type NewTicket,
  type StopRequest,
  type Ticket,
  type TicketComment,
  type TicketPatch,
  type TicketQuery,
  type TicketStatus,
  type TicketStore,
  type TrackerPhase,
} from "../types.js";
import { matches } from "./beads.js";
import { LinearApiError, LinearClient, type LinearClientOptions } from "./linear-client.js";
import {
  columnFor,
  DEFAULT_PHASE_COLUMNS,
  DEFAULT_STATE_NAMES,
  isCommentKey,
  isTerminal,
  type LinearMeta,
  type LinearPhaseColumns,
  type LinearStateNames,
  openBlockers,
  readBody,
  safeMeta,
  toLinearPriority,
  toTicket,
  writeBody,
} from "./linear-mapping.js";
import { findLegacyBlock, type LinearMetaStore } from "./linear-meta.js";
import * as Q from "./linear-queries.js";

export { LinearApiError, sanitizeUntrusted } from "./linear-client.js";
export { type LinearMetaStore, MemoryLinearMetaStore } from "./linear-meta.js";

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
  /**
   * Host-side per-issue meta. When set, Matrix keeps nothing in issue descriptions and migrates
   * old `<!-- matrix:{...} -->` blocks out of them; without it the legacy block is still written.
   */
  metaStore?: LinearMetaStore;
}

const norm = (s: string) => s.trim().toLowerCase();
/** Legacy comment markers, also as Linear renders them back (`-->` shown as `→`, or escaped). */
const OPEN = String.raw`(?:<!--|&lt;!--)\s*`;
const CLOSE = String.raw`\s*(?:-->|--&gt;|→)`;
const ANY_MARKER = new RegExp(`${OPEN}matrix(?::bot|-comment:[a-z0-9-]{1,40})${CLOSE}`);
/** `key` is validated by `isCommentKey`, so it is regex-safe. */
const keyMarker = (key: string) => new RegExp(`${OPEN}matrix-comment:${key}${CLOSE}`);
/** Coarse statuses the reconciler sets at phase start; with a phase they map to its column. */
const PHASED = new Set<TicketStatus>(["in_progress", "review", "qa"]);
/** Linear state types of columns before work starts (Backlog, Todo, Triage). */
const NOT_STARTED_TYPES = new Set(["backlog", "unstarted", "triage"]);

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
  readonly #host: LinearMetaStore | undefined;
  #team: Promise<Team> | undefined;
  #viewer: Promise<string> | undefined;
  /** Issues whose legacy block strip was already tried by this process (one try each). */
  readonly #stripTried = new Set<string>();

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
    this.#host = options.metaStore;
  }

  /** True when Matrix acts as its own Linear app user (OAuth client credentials). */
  get appMode(): boolean {
    return this.#client.authMode === "app";
  }

  /** Matrix's Linear user id (the app user in app mode, the key's human otherwise). */
  viewerId(): Promise<string> {
    this.#viewer ??= this.#client
      .request<{ viewer: { id: string } }>(Q.VIEWER)
      .then((d) => {
        if (!d.viewer?.id) throw new LinearApiError("Linear viewer has no id");
        return d.viewer.id;
      })
      .catch((error) => {
        this.#viewer = undefined;
        throw error;
      });
    return this.#viewer;
  }

  /** Matrix's meta for an issue: host-side when available, else the legacy description block. */
  #meta(issue: Q.LinearIssue): LinearMeta {
    const legacy = readBody(issue.description).meta;
    if (!this.#host) return legacy;
    return this.#host.get(issue.id) ?? legacy;
  }

  async #saveMeta(issue: Q.LinearIssue, text: string, meta: LinearMeta): Promise<void> {
    if (this.#host) {
      this.#host.set(issue.id, safeMeta(meta as Record<string, unknown>));
      return;
    }
    const data = await this.#client.request<{ issueUpdate: { success: boolean } }>(Q.UPDATE_ISSUE, {
      id: issue.id,
      input: { description: writeBody(text, meta) },
    });
    if (!data.issueUpdate.success)
      throw new LinearApiError(`Linear issueUpdate ${issue.identifier} failed`);
  }

  /**
   * Moves a legacy description block host-side and strips it from the description. Only a block
   * in Matrix's exact format at the very end is touched; the text before it is kept byte for byte,
   * and nothing is written when the description changed since it was read (a human editing).
   */
  async #migrate(issue: Q.LinearIssue): Promise<void> {
    if (!this.#host) return;
    const block = findLegacyBlock(issue.description);
    if (!block) return;
    // Host data wins; only a host entry with nothing but Matrix's last column adopts the block.
    const host = this.#host.get(issue.id);
    if (!host || Object.keys(host).every((k) => k === "lastState"))
      this.#host.set(issue.id, { ...safeMeta(block.meta), ...host });
    if (this.#stripTried.has(issue.id)) return;
    try {
      const fresh = await this.#client.request<{ issue: Q.LinearIssue | null }>(Q.GET_ISSUE, {
        id: issue.id,
      });
      if (fresh.issue?.description !== issue.description) return;
      this.#stripTried.add(issue.id);
      await this.#client.request(Q.UPDATE_ISSUE, {
        id: issue.id,
        input: { description: block.text },
      });
      issue.description = block.text;
    } catch {
      // Best effort: the block is still read as a fallback (one strip attempt per process).
    }
  }

  #ticket(issue: Q.LinearIssue): Ticket {
    return toTicket(issue, this.#names, this.#host ? this.#meta(issue) : undefined);
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

  /** State id by name, or undefined when the team has no such column (custom boards). */
  async #optionalStateId(name: string): Promise<string | undefined> {
    return (await this.#loadTeam()).states.get(norm(name))?.id;
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
      if (!data.issues.pageInfo.hasNextPage) {
        const scoped = out.filter((i) => this.#inScope(i));
        for (const i of scoped) await this.#migrate(i);
        return scoped;
      }
      after = data.issues.pageInfo.endCursor;
      if (!after) throw new LinearApiError("Linear pagination returned no cursor");
    }
    throw new LinearApiError("Linear pagination exceeded 10000 issues");
  }

  async #issue(id: string): Promise<Q.LinearIssue | null> {
    if (!this.#idOk(id)) return null;
    try {
      const data = await this.#client.request<{ issue: Q.LinearIssue | null }>(Q.GET_ISSUE, { id });
      if (!data.issue || !this.#inScope(data.issue)) return null;
      await this.#migrate(data.issue);
      return data.issue;
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
    return (await this.#issues()).map((i) => this.#ticket(i)).filter((t) => matches(t, query));
  }

  async get(id: string): Promise<Ticket | null> {
    const issue = await this.#issue(id);
    return issue ? this.#ticket(issue) : null;
  }

  async ready(): Promise<Ticket[]> {
    const issues = await this.#issues({ state: { name: { eqIgnoreCase: this.#names.ready } } });
    return issues
      .filter((i) => i.state.name.trim().toLowerCase() === this.#names.ready.trim().toLowerCase())
      .filter((i) => this.#requeueable(i))
      .filter((i) => openBlockers(i).length === 0)
      .map((i) => ({ ...this.#ticket(i), status: "ready" as const }));
  }

  /**
   * One query per call (by issue number, in not-started columns), however many ids. In app mode
   * the issue history tells who moved it: a move by Matrix's own app user is not a stop request.
   * With a personal key (or when history is unavailable) any such move counts, as before.
   */
  async stopRequests(ids: string[]): Promise<StopRequest[]> {
    const numbers = ids.filter((id) => this.#idOk(id)).map((id) => Number(id.split("-")[1]));
    if (!numbers.length) return [];
    const wanted = new Set(ids);
    const issues = await this.#issues({
      number: { in: numbers },
      state: { type: { in: [...NOT_STARTED_TYPES] } },
    });
    const candidates = issues.filter((i) => wanted.has(i.identifier) && this.#inStopColumn(i));
    const out: StopRequest[] = [];
    for (const i of candidates)
      if (!(await this.#movedByMatrix(i))) out.push({ id: i.identifier, column: i.state.name });
    return out;
  }

  /**
   * Who made the latest move into the issue's current column: `matrix`, `other`, or undefined
   * when nothing can tell. Linear's history is eventually consistent (a move can take many seconds
   * to appear, moves right after creation may never appear), so it is combined with the column
   * Matrix last wrote (host-side): a recorded human move wins; else a current column that differs
   * from Matrix's last write is a human's; else Matrix's own write. History only counts in app
   * mode (a personal key shares the human's identity).
   */
  async #lastMoveBy(issue: Q.LinearIssue): Promise<"matrix" | "other" | undefined> {
    const history = this.appMode ? await this.#historyMoveBy(issue) : undefined;
    if (history === "other") return "other";
    const written = this.#host?.get(issue.id)?.lastState;
    if (written !== undefined) return norm(written) === norm(issue.state.name) ? "matrix" : "other";
    return history;
  }

  async #historyMoveBy(issue: Q.LinearIssue): Promise<"matrix" | "other" | undefined> {
    try {
      const data = await this.#client.request<{
        issue: { history: { nodes: Q.LinearHistoryNode[] } } | null;
      }>(Q.ISSUE_HISTORY, { id: issue.id });
      const last = (data.issue?.history.nodes ?? [])
        .filter((n) => n.toState)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!last || norm(last.toState?.name ?? "") !== norm(issue.state.name)) return undefined;
      if (!last.actor?.id) return undefined;
      return last.actor.id === (await this.viewerId()) ? "matrix" : "other";
    } catch {
      return undefined;
    }
  }

  /** Records the column Matrix just moved the issue into (host mode). */
  #wrote(issueUuid: string, stateName: string): void {
    if (!this.#host) return;
    const meta = this.#host.get(issueUuid) ?? {};
    this.#host.set(issueUuid, { ...meta, lastState: stateName });
  }

  async #stateName(stateId: string): Promise<string | undefined> {
    for (const s of (await this.#loadTeam()).states.values()) if (s.id === stateId) return s.name;
    return undefined;
  }

  async #movedByMatrix(issue: Q.LinearIssue): Promise<boolean> {
    return (await this.#lastMoveBy(issue)) === "matrix";
  }

  /** Backlog/Todo/Triage, never Ready: where a human parks an issue to stop Matrix. */
  #inStopColumn(issue: Q.LinearIssue): boolean {
    return (
      NOT_STARTED_TYPES.has(issue.state.type) && norm(issue.state.name) !== norm(this.#names.ready)
    );
  }

  /**
   * True when a human parked the issue in a stop column, so Matrix must not move it out (the
   * reconciler's stop poll then cancels the workflow). App mode asks the issue history; otherwise
   * (or when history cannot tell) an issue Matrix already worked on (it has a phase) counts.
   */
  async #humanHold(issue: Q.LinearIssue): Promise<boolean> {
    if (!this.#inStopColumn(issue)) return false;
    const by = await this.#lastMoveBy(issue);
    if (by) return by === "other";
    return this.#meta(issue).phase !== undefined;
  }

  /**
   * A Matrix-blocked issue is eligible again once a human acts on it: moved to Ready from the
   * column it was blocked in, or (when blocked while in Ready) the needs-human label was removed.
   */
  #requeueable(issue: Q.LinearIssue): boolean {
    const { blocked, blockedIn } = this.#meta(issue);
    if (!blocked) return true;
    // Unknown origin (blocked before `blockedIn` existed) counts as blocked in Ready.
    if (blockedIn !== undefined && norm(blockedIn) !== norm(issue.state.name)) return true;
    return !issue.labels.nodes.some((l) => l.name === NEEDS_HUMAN_LABEL);
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
        description: this.#host ? input.body : writeBody(input.body, {}),
        labelIds,
        stateId: await this.#stateId("open"),
        ...(input.priority !== undefined ? { priority: toLinearPriority(input.priority) } : {}),
        ...(parent ? { parentId: parent.id } : {}),
      },
    });
    const issue = data.issueCreate.issue;
    if (!data.issueCreate.success || !issue) throw new LinearApiError("Linear issueCreate failed");
    this.#wrote(issue.id, this.#names.open);
    for (const dep of input.deps ?? []) await this.link(dep, issue.identifier, "blocks");
    return (await this.get(issue.identifier)) ?? this.#ticket(issue);
  }

  async update(id: string, patch: TicketPatch): Promise<Ticket> {
    const issue = await this.#must(id);
    const text = readBody(issue.description).text;
    const meta = this.#meta(issue);
    if (patch.phase !== undefined) meta.phase = patch.phase;
    if (patch.status !== undefined) {
      meta.blocked = patch.status === "blocked";
      if (meta.blocked) meta.blockedIn = issue.state.name;
      else delete meta.blockedIn;
    }
    // Host mode: the description is the human's text only, written when the body changes.
    const input: Record<string, unknown> = this.#host
      ? patch.body !== undefined
        ? { description: patch.body }
        : {}
      : { description: writeBody(patch.body ?? text, meta) };
    if (patch.title !== undefined) input.title = patch.title;
    if (patch.priority !== undefined) input.priority = toLinearPriority(patch.priority);
    // "blocked" keeps the current column; the flag lives in the body block.
    if (patch.status !== undefined && patch.status !== "blocked") {
      const column =
        patch.phase !== undefined && PHASED.has(patch.status)
          ? columnFor({ phase: patch.phase, status: "running" }, this.#names, this.#phases)
          : undefined;
      // A phase start never pulls an issue a human finished or canceled back onto the board.
      const reopen = isTerminal(issue.state.type) && PHASED.has(patch.status);
      // A phase start never moves an issue out of the column a human parked it in to stop
      // Matrix; `ready` (a deliberate restart) and other statuses always apply.
      const held = PHASED.has(patch.status) && (await this.#humanHold(issue));
      if (!reopen && !held)
        input.stateId =
          (column ? await this.#optionalStateId(column) : undefined) ??
          (await this.#stateId(patch.status));
    }
    if (patch.labels !== undefined)
      input.labelIds = await this.#labelIds([this.#label, ...patch.labels]);
    if (patch.assignee !== undefined) input.assigneeId = await this.#userId(patch.assignee);
    if (patch.parent !== undefined) input.parentId = (await this.#must(patch.parent)).id;
    if (Object.keys(input).length) {
      const data = await this.#client.request<{
        issueUpdate: { success: boolean; issue: Q.LinearIssue | null };
      }>(Q.UPDATE_ISSUE, { id: issue.id, input });
      if (!data.issueUpdate.success) throw new LinearApiError(`Linear issueUpdate ${id} failed`);
    }
    if (this.#host) {
      const moved =
        typeof input.stateId === "string" ? await this.#stateName(input.stateId) : undefined;
      const lastState = moved ?? this.#host.get(issue.id)?.lastState;
      this.#host.set(issue.id, safeMeta({ ...meta, ...(lastState ? { lastState } : {}) }));
    }
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

  async uploadFile(
    id: string,
    name: string,
    contentType: string,
    bytes: Uint8Array,
  ): Promise<string> {
    await this.#must(id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name))
      throw new Error("invalid upload file name");
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("upload larger than 10 MB");
    return this.#client.upload(name, contentType, bytes);
  }

  async comment(id: string, body: string): Promise<void> {
    await this.#createComment(await this.#must(id), body);
  }

  /**
   * App mode posts the body as is (Matrix is recognised by its own Linear user). With a personal
   * key the legacy hidden marker is still appended, since the author is the human's identity.
   */
  async #createComment(issue: Q.LinearIssue, body: string): Promise<string> {
    const data = await this.#client.request<{
      commentCreate: { success: boolean; comment: { id: string } | null };
    }>(Q.CREATE_COMMENT, {
      input: {
        issueId: issue.id,
        body: this.appMode ? body : `${body}\n\n${MATRIX_COMMENT_MARKER}`,
      },
    });
    if (!data.commentCreate.success || !data.commentCreate.comment)
      throw new LinearApiError(`Linear comment on ${issue.identifier} failed`);
    return data.commentCreate.comment.id;
  }

  /** Whether `user` is Matrix: its app user id in app mode, the key's user otherwise. */
  async #isMatrix(user: { id?: string; isMe?: boolean } | null | undefined): Promise<boolean> {
    if (!user) return false;
    if (!this.appMode) return user.isMe === true;
    return typeof user.id === "string" && user.id === (await this.viewerId());
  }

  /** Moves the issue to the column of a workflow phase; never reopens a finished issue. */
  async setPhase(id: string, position: TrackerPhase): Promise<void> {
    const column = columnFor(position, this.#names, this.#phases);
    if (!column) return;
    const issue = await this.#must(id);
    if (norm(issue.state.name) === norm(column)) return;
    // A human closed or canceled it while Matrix worked: leave it there.
    if (isTerminal(issue.state.type)) return;
    // A human parked it in Backlog/Todo/Triage: never override that (the stop poll cancels).
    if (await this.#humanHold(issue)) return;
    // Boards without this column keep the coarse column the reconciler already set.
    const stateId = await this.#optionalStateId(column);
    if (!stateId) return;
    const data = await this.#client.request<{ issueUpdate: { success: boolean } }>(Q.UPDATE_ISSUE, {
      id: issue.id,
      input: { stateId },
    });
    if (!data.issueUpdate.success) throw new LinearApiError(`Linear move of ${id} failed`);
    this.#wrote(issue.id, column);
  }

  /**
   * One live comment per `key`: created once, then edited in place. Its id is kept in Matrix's
   * per-issue meta (host-side, or the legacy description block); a deleted comment is recreated.
   */
  async upsertComment(id: string, key: string, body: string): Promise<void> {
    if (!isCommentKey(key)) throw new Error(`invalid comment key ${JSON.stringify(key)}`);
    const issue = await this.#must(id);
    const text = this.appMode ? body : `${body}\n\n<!-- matrix-comment:${key} -->`;
    const known = this.#meta(issue).comments?.[key];
    // The stored id is untrusted (a legacy block is editable by anyone): only edit Matrix's own
    // comment on this very issue. Otherwise recover a lost id by marker, else create a new one.
    const target =
      (known && (await this.#ownComment(known, issue.id)) ? known : undefined) ??
      (await this.#markedComment(issue.id, key));
    if (target) {
      const data = await this.#client.request<{ commentUpdate: { success: boolean } }>(
        Q.UPDATE_COMMENT,
        { id: target, input: { body: text } },
      );
      if (!data.commentUpdate.success) throw new LinearApiError(`Linear comment on ${id} failed`);
      if (target === known) return;
    }
    const commentId = target ?? (await this.#createComment(issue, text));
    // Re-read right before writing so a human edit (or a concurrent meta write) is kept.
    const fresh = await this.#must(id);
    const meta = this.#meta(fresh);
    meta.comments = { ...meta.comments, [key]: commentId };
    await this.#saveMeta(fresh, readBody(fresh.description).text, meta);
  }

  async #ownComment(commentId: string, issueUuid: string): Promise<boolean> {
    try {
      const data = await this.#client.request<{
        comment: {
          issue: { id: string } | null;
          user: { id?: string; isMe: boolean } | null;
        } | null;
      }>(Q.COMMENT, { id: commentId });
      return data.comment?.issue?.id === issueUuid && (await this.#isMatrix(data.comment.user));
    } catch (error) {
      if (error instanceof LinearApiError && /not found/i.test(error.message)) return false;
      throw error;
    }
  }

  /** Legacy recovery: Matrix's own comment carrying the keyed marker (even after round-trip). */
  async #markedComment(issueUuid: string, key: string): Promise<string | undefined> {
    const data = await this.#client.request<{
      issue: {
        comments: {
          nodes: Array<{ id: string; body: string; user: { id?: string; isMe: boolean } | null }>;
        };
      } | null;
    }>(Q.ISSUE_COMMENTS, { id: issueUuid });
    const marker = keyMarker(key);
    for (const c of data.issue?.comments.nodes ?? [])
      if (marker.test(c.body) && (await this.#isMatrix(c.user))) return c.id;
    return undefined;
  }

  /** Makes sure the project label exists on the team (created when missing). */
  async ensureScope(): Promise<void> {
    await this.#labelIds([this.#label]);
  }

  async addLabel(id: string, label: string): Promise<void> {
    const issue = await this.#must(id);
    if (issue.labels.nodes.some((l) => l.name === label)) return;
    const [labelId] = await this.#labelIds([label]);
    const data = await this.#client.request<{ issueAddLabel: { success: boolean } }>(Q.ADD_LABEL, {
      id: issue.id,
      labelId,
    });
    if (!data.issueAddLabel.success) throw new LinearApiError(`Linear add label on ${id} failed`);
  }

  async removeLabel(id: string, label: string): Promise<void> {
    // The project label scopes the issue to this store: never drop it.
    if (label === this.#label) return;
    const issue = await this.#must(id);
    const found = issue.labels.nodes.find((l) => l.name === label);
    if (!found) return;
    const data = await this.#client.request<{ issueRemoveLabel: { success: boolean } }>(
      Q.REMOVE_LABEL,
      { id: issue.id, labelId: found.id },
    );
    if (!data.issueRemoveLabel.success)
      throw new LinearApiError(`Linear remove label on ${id} failed`);
  }

  /**
   * Comments oldest first, sanitized. App mode: Matrix's comments are those its app user wrote;
   * legacy marked comments (posted earlier with a personal key) also count, which can only hide a
   * comment from prompts, never lend it Matrix's authority. Personal key: the key's user wrote it
   * AND it carries a marker, since that identity is shared with the human.
   */
  async listComments(id: string): Promise<TicketComment[]> {
    const issue = await this.#must(id);
    const data = await this.#client.request<{
      issue: {
        comments: {
          nodes: Array<{
            id: string;
            body: string;
            createdAt?: string;
            user: { id?: string; isMe: boolean; displayName?: string; name?: string } | null;
          }>;
        };
      } | null;
    }>(Q.ISSUE_COMMENTS, { id: issue.id });
    const out: TicketComment[] = [];
    for (const c of data.issue?.comments.nodes ?? []) {
      const marked = ANY_MARKER.test(c.body);
      const own = await this.#isMatrix(c.user);
      const author = c.user?.displayName || c.user?.name;
      out.push({
        id: c.id,
        body: sanitizeUntrusted(c.body),
        byMatrix: this.appMode ? own || marked : own && marked,
        ...(author ? { author: sanitizeUntrusted(author) } : {}),
        ...(c.createdAt ? { createdAt: c.createdAt } : {}),
      });
    }
    return out.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
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
