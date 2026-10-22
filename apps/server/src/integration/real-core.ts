import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AutonomyMode,
  type EventBus,
  PHASES,
  type Phase,
  type QuotaStatus,
  type Receipt,
  type Reconciler,
  type RunEvent,
  type Store,
} from "@matrix/core";
import type { NewTicket, Ticket, TicketPatch, TicketQuery, TicketStore } from "@matrix/tickets";
import {
  type Actor,
  type Approval,
  type ApprovalDecision,
  type ApprovalStatus,
  type CheckResult,
  CoreError,
  type CorePort,
  type CreateProjectInput,
  type Incident,
  type IncidentStatus,
  type InitSession,
  type ModelHealth,
  type MonitorSignal,
  type OrcaRuntime,
  type OrcaStatus,
  type ProductGraph,
  type Project,
  type Run,
  type Adr as ServerAdr,
  type UpdateProjectInput,
} from "../core-port.js";
import { PrivateState } from "../private-state.js";
import type { PrivateStateOwner } from "../state-owner.js";
import {
  defaultEditablePaths,
  detectChecks,
  resolveExistingRepo,
  validateEditablePaths,
} from "./existing-repo.js";
import { type FinalizeJournal, finalizeProject } from "./finalize.js";
import { newProjectConfig, type StoredProject, toApproval, toProject, toRun } from "./mapping.js";
import { applyModelPlan, assertKnownModels, type ModelLister } from "./model-plan.js";
import { TicketSnapshotLock } from "./ticket-snapshot-lock.js";
import {
  DEFAULT_TICKETS,
  type TicketBinaries,
  type TicketSettings,
  ticketStoreFor,
  trackerDeadline,
} from "./tickets.js";
import type { TrackerFailure, TrackerHealth } from "./tracker-health.js";

export interface KnowledgePort {
  adrs(repoPath: string): Promise<ServerAdr[]>;
  graph(repoPath: string): Promise<ProductGraph>;
  checks(repoPath: string, baseBranch?: string): Promise<CheckResult>;
}

export interface MonitorPort {
  ingest(signal: MonitorSignal): Promise<{ id: string }>;
  incidents(query: { projectId?: string; status?: IncidentStatus }): Promise<Incident[]>;
}

export interface RealCoreOptions {
  stateOwner?: PrivateStateOwner;
  fakeRuntime?: boolean;
  stateFile?: string;
  store: Store;
  bus: EventBus;
  reconciler: Reconciler;
  projectsRoot: string;
  host: string;
  knowledge: KnowledgePort;
  monitor: MonitorPort;
  /** Prepares a new project's repo (git, ticket tracker). */
  initRepo?: (repoPath: string, tickets: TicketSettings) => Promise<void>;
  /** CLI binaries for ticket adapters. */
  binaries?: TicketBinaries;
  /** Overrides the ticket store per project (tests). */
  ticketsFor?: (project: StoredProject) => TicketStore;
  /** Recent tracker write failures (see `getTrackerFailures`). */
  trackerHealth?: TrackerHealth;
  /** `MATRIX_REPO_ROOTS`: where existing repos may be registered from; empty = feature off. */
  repoRoots?: string[];
  /** Runtime-side check (and registration) of an existing repo, e.g. Orca's repo list. */
  verifyRepo?: (repoPath: string) => Promise<void>;
  /** Model ids the gateway serves (model plans are validated against it when reachable). */
  listModels?: ModelLister;
  gitBinary?: string;
}

/** Maps core's plain errors onto the server's error codes. */
function translate(error: unknown): never {
  if (error instanceof CoreError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) throw new CoreError("not_found", message);
  if (/cannot be decided|requires|human/i.test(message)) throw new CoreError("forbidden", message);
  throw new CoreError("invalid_state", message);
}

/**
 * CorePort over the real orchestrator: projects and workflows live in the core store (Postgres in
 * production), runs are dispatched by the reconciler, approvals are decided through it, and run
 * events come from its event bus.
 */
export class RealCore implements CorePort {
  private readonly ticketStores = new Map<string, TicketStore>();
  private readonly inits = new Map<string, InitSession>();
  private settings: Record<string, unknown> = {};
  private readonly orca: OrcaStatus[] = [];
  readonly modelHealth: ModelHealth[] = [];
  private readonly state: PrivateState<{ inits: InitSession[]; settings: Record<string, unknown> }>;
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly ticketSyncs = new Map<string, Promise<void>>();
  private readonly hydratedTickets = new Set<string>();
  private readonly scopedTickets = new Set<string>();
  private readonly finalizingProjects = new Set<string>();
  private readonly ticketSnapshotLock = new TicketSnapshotLock();

  withTicketSnapshotLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    return this.ticketSnapshotLock.run(projectId, () => {
      this.o.stateOwner?.assertOwned();
      return operation();
    });
  }

  projectDispatchAllowed(projectId: string): boolean {
    if (this.finalizingProjects.has(projectId)) return false;
    if (!this.o.stateFile) return true;
    const journal = new PrivateState<FinalizeJournal | null>(
      join(this.o.projectsRoot, `${projectId}.init.json`),
      this.o.stateOwner,
    ).load(null);
    return !journal || journal.completed?.result.status === "ok";
  }

  constructor(private readonly o: RealCoreOptions) {
    this.state = new PrivateState(o.stateFile, o.stateOwner);
    const saved = this.state.load({ inits: [], settings: {} });
    for (const session of saved.inits) this.inits.set(session.id, session);
    this.settings = saved.settings;
  }

  private persist(): void {
    this.o.stateOwner?.assertOwned();
    this.state.save({ inits: [...this.inits.values()], settings: this.settings });
  }

  get stateOwner(): PrivateStateOwner | undefined {
    return this.o.stateOwner;
  }

  private async mutate<T>(key: string, action: () => Promise<T>): Promise<T> {
    this.o.stateOwner?.assertOwned();
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => (this.o.stateOwner ? this.o.stateOwner.guard(action) : action()));
    this.mutations.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.mutations.get(key) === pending) this.mutations.delete(key);
    }
  }

  async ticketStore(projectId: string): Promise<TicketStore> {
    const cached = this.ticketStores.get(projectId);
    if (cached) return cached;
    const project = await this.config(projectId);
    const store = this.o.ticketsFor
      ? this.o.ticketsFor(project)
      : ticketStoreFor(
          project.repoPath,
          project.matrix?.tickets ?? DEFAULT_TICKETS,
          this.o.binaries,
          this.o.stateOwner,
        );
    this.o.stateOwner?.assertOwned();
    const indexed: TicketStore = {
      kind: store.kind,
      list: (query) => store.list(query),
      get: (id) => store.get(id),
      ready: () =>
        this.withTicketSnapshotLock(projectId, async () => {
          await this.syncTicketsLocked(projectId);
          return store.ready();
        }),
      comment: (id, body) => this.withTicketSnapshotLock(projectId, () => store.comment(id, body)),
      link: (from, to, type) =>
        this.withTicketSnapshotLock(projectId, async () => {
          await store.link(from, to, type);
          const ticket = await store.get(type === "related" ? from : to);
          if (ticket) await this.index(projectId, ticket);
        }),
      create: (input) =>
        this.withTicketSnapshotLock(projectId, async () => {
          const ticket = await store.create(input);
          await this.index(projectId, ticket);
          return ticket;
        }),
      update: (id, patch) =>
        this.withTicketSnapshotLock(projectId, async () => {
          const ticket = await store.update(id, patch);
          await this.index(projectId, ticket);
          return ticket;
        }),
    };
    if (store.setPhase) {
      const move = store.setPhase.bind(store);
      indexed.setPhase = (id, position) =>
        this.withTicketSnapshotLock(projectId, async () => {
          await move(id, position);
          const ticket = await store.get(id);
          if (ticket) await this.index(projectId, ticket);
        });
    }
    if (store.upsertComment) {
      const upsert = store.upsertComment.bind(store);
      indexed.upsertComment = (id, key, body) =>
        this.withTicketSnapshotLock(projectId, () => upsert(id, key, body));
    }
    if (store.ensureScope) indexed.ensureScope = store.ensureScope.bind(store);
    const owned = this.o.stateOwner?.fence(indexed) ?? indexed;
    this.ticketStores.set(projectId, owned);
    return owned;
  }

  private async config(projectId: string): Promise<StoredProject> {
    const project = (await this.o.store.getProject(projectId)) as StoredProject | null;
    if (!project) throw new CoreError("not_found", `project ${projectId} not found`);
    return project;
  }

  // ── projects ────────────────────────────────────────────────────────────────────────────────

  async listProjects(): Promise<Project[]> {
    return (await this.o.store.listProjects()).map((p) => toProject(p as StoredProject));
  }

  async getProject(id: string): Promise<Project | null> {
    const project = (await this.o.store.getProject(id)) as StoredProject | null;
    return project ? toProject(project) : null;
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    this.o.stateOwner?.assertOwned();
    if (input.repo) return this.registerRepo({ ...input, repo: input.repo });
    const id = randomUUID();
    const repoPath = join(this.o.projectsRoot, id);
    await mkdir(this.o.projectsRoot, { recursive: true });
    this.o.stateOwner?.assertOwned();
    await mkdir(repoPath);
    this.o.stateOwner?.assertOwned();
    try {
      await this.o.initRepo?.(repoPath, input.tickets ?? DEFAULT_TICKETS);
    } catch (error) {
      this.o.stateOwner?.assertOwned();
      rmSync(repoPath, { recursive: true, force: true });
      throw error;
    }
    this.o.stateOwner?.assertOwned();
    const config = newProjectConfig({
      id,
      name: input.name,
      repoPath,
      host: this.o.host,
      meta: {
        description: input.description,
        workspace: input.workspace,
        tickets: input.tickets ?? DEFAULT_TICKETS,
        createdAt: new Date().toISOString(),
      },
    });
    if (this.o.fakeRuntime)
      config.models = {
        implement: { runner: "claude-code", model: "fake-implementer" },
        review: { runner: "codex", model: "fake-reviewer" },
      };
    if (input.checks) config.checks = input.checks;
    if (input.models) {
      await assertKnownModels(input.models, this.o.listModels);
      applyModelPlan(config, input.models);
    }
    await this.o.store.upsertProject(config);
    // Remote trackers (GitHub, Linear) may already hold issues: hydrate them on first use.
    const remote =
      config.matrix?.tickets.kind === "github" || config.matrix?.tickets.kind === "linear";
    if (!remote && !this.o.ticketsFor) this.hydratedTickets.add(id);
    return toProject(config);
  }

  /**
   * Registers a repo that already exists on the host. Validated (allowlisted real path, canonical
   * git repo, base branch, GitHub remote, runtime registration), then recorded host-side only:
   * no init interview and nothing written into the repo. Runs end with a draft PR.
   */
  private async registerRepo(
    input: CreateProjectInput & { repo: NonNullable<CreateProjectInput["repo"]> },
  ): Promise<Project> {
    return this.mutate("register-repo", async () => {
      const tickets = input.tickets;
      if (!tickets || (tickets.kind !== "linear" && tickets.kind !== "github"))
        throw new CoreError(
          "invalid_request",
          "existing repos need a remote tracker (tickets.kind linear or github): Matrix writes nothing into the repo",
        );
      const git = this.o.gitBinary ? { gitBinary: this.o.gitBinary } : {};
      const registered = (await this.o.store.listProjects()).map((p) => p.repoPath);
      const repo = await resolveExistingRepo(input.repo, this.o.repoRoots ?? [], registered, git);
      const own = await realpath(this.o.projectsRoot).catch(() => resolve(this.o.projectsRoot));
      if (repo.path === own || repo.path.startsWith(`${own}/`))
        throw new CoreError("invalid_request", "repos Matrix created cannot be registered again");
      if (input.models) await assertKnownModels(input.models, this.o.listModels);
      await this.o.verifyRepo?.(repo.path);
      this.o.stateOwner?.assertOwned();
      const id = randomUUID();
      const config = newProjectConfig({
        id,
        name: input.name,
        repoPath: repo.path,
        host: this.o.host,
        meta: {
          description: input.description,
          workspace: input.workspace,
          tickets,
          createdAt: new Date().toISOString(),
          repo: { external: true, remote: repo.remote, github: repo.github },
        },
      });
      config.baseBranch = repo.baseBranch;
      // Matrix stops at merge: the human merges the draft PR on GitHub.
      config.lastPhase = "merge";
      config.checks = input.checks ?? (await detectChecks(repo, git));
      const editablePaths = input.repo.editablePaths
        ? validateEditablePaths(input.repo.editablePaths)
        : await defaultEditablePaths(repo, git);
      if (config.matrix?.repo) config.matrix.repo.editablePaths = editablePaths;
      if (this.o.fakeRuntime)
        config.models = {
          implement: { runner: "claude-code", model: "fake-implementer" },
          review: { runner: "codex", model: "fake-reviewer" },
        };
      if (input.models) applyModelPlan(config, input.models);
      await this.o.store.upsertProject(config);
      return toProject(config);
    });
  }

  /** Tracker, checks and model plan after registration (host-side config only). */
  async updateProject(projectId: string, patch: UpdateProjectInput): Promise<Project> {
    return this.mutate(`project:${projectId}`, async () => {
      const current = await this.config(projectId);
      const external = Boolean(current.matrix?.repo);
      if (patch.tickets) {
        if (external && patch.tickets.kind !== "linear" && patch.tickets.kind !== "github")
          throw new CoreError(
            "invalid_request",
            "existing repos need tickets.kind linear or github",
          );
        if (!external && patch.tickets.kind !== current.matrix?.tickets.kind)
          throw new CoreError(
            "invalid_request",
            "a Matrix-created repo cannot switch tracker kind after creation",
          );
      }
      if (patch.repo?.editablePaths && !external)
        throw new CoreError("invalid_request", "editablePaths only applies to existing repos");
      const editable = patch.repo?.editablePaths
        ? validateEditablePaths(patch.repo.editablePaths)
        : undefined;
      if (patch.models) await assertKnownModels(patch.models, this.o.listModels);
      const config = structuredClone(await this.config(projectId));
      if (patch.tickets && config.matrix)
        config.matrix = { ...config.matrix, tickets: patch.tickets };
      if (editable && config.matrix?.repo) config.matrix.repo.editablePaths = editable;
      if (patch.checks)
        config.checks = patch.checks.map((c) => ({ kind: c.kind, cmd: [...c.cmd] }));
      if (patch.models) applyModelPlan(config, patch.models);
      this.o.stateOwner?.assertOwned();
      await this.o.store.upsertProject(config);
      if (patch.tickets) {
        this.ticketStores.delete(projectId);
        this.scopedTickets.delete(projectId);
        this.hydratedTickets.delete(projectId);
      }
      return toProject(config);
    });
  }

  async getProjectPolicy(projectId: string) {
    if (!(await this.o.store.getProject(projectId))) return null;
    const snapshot = await this.o.store.getProjectPolicy(projectId);
    return { project: toProject(snapshot.project as StoredProject), version: snapshot.version };
  }

  async setAutonomy(
    projectId: string,
    phase: Phase,
    mode: AutonomyMode,
    actor: Actor,
  ): Promise<Project> {
    await this.config(projectId);
    await this.o.reconciler.setAutonomy(projectId, phase, mode, actor.id);
    return toProject(await this.config(projectId));
  }

  async setAutonomyPolicy(
    projectId: string,
    policy: Partial<Record<Phase, AutonomyMode>>,
    actor: Actor,
    expected?: string,
  ): Promise<Project> {
    await this.o.store.setAutonomyPolicy(projectId, policy, actor.id, expected);
    return toProject(await this.config(projectId));
  }

  // ── tickets ─────────────────────────────────────────────────────────────────────────────────

  private async index(projectId: string, ticket: Ticket): Promise<void> {
    await this.o.store.indexTicket(projectId, {
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      labels: ticket.labels,
      ...(ticket.priority === undefined ? {} : { priority: ticket.priority }),
      ...(ticket.url ? { url: ticket.url } : {}),
      snapshot: ticket,
    });
  }

  async listTickets(projectId: string, query?: TicketQuery): Promise<Ticket[]> {
    await this.config(projectId);
    await this.hydrateTickets(projectId);
    return (await this.o.store.listIndexedTickets(projectId)).filter(
      (ticket) =>
        (!query?.status || query.status.includes(ticket.status)) &&
        (!query?.labels || query.labels.every((label) => ticket.labels.includes(label))),
    );
  }

  async getTicket(projectId: string, ticketId: string): Promise<Ticket | null> {
    await this.config(projectId);
    await this.hydrateTickets(projectId);
    return this.o.store.getIndexedTicket(projectId, ticketId);
  }

  private async hydrateTickets(projectId: string): Promise<void> {
    if (this.hydratedTickets.has(projectId)) return;
    try {
      await this.syncTickets(projectId);
    } catch {
      this.o.stateOwner?.assertOwned();
      throw new CoreError(
        "tracker_unavailable",
        "Ticket snapshot unavailable: tracker hydration failed or timed out. Retry after the tracker recovers.",
      );
    }
  }

  async syncTickets(projectId?: string): Promise<void> {
    const projects = projectId ? [await this.config(projectId)] : await this.o.store.listProjects();
    await Promise.all(
      projects.map((project) => {
        const active = this.ticketSyncs.get(project.id);
        if (active) return active;
        const pending = this.withTicketSnapshotLock(project.id, () =>
          this.syncTicketsLocked(project.id),
        );
        this.ticketSyncs.set(project.id, pending);
        return pending.finally(() => {
          if (this.ticketSyncs.get(project.id) === pending) this.ticketSyncs.delete(project.id);
        });
      }),
    );
  }

  private async syncTicketsLocked(projectId: string): Promise<void> {
    await trackerDeadline(async (signal) => {
      const store = await this.ticketStore(projectId);
      if (!this.scopedTickets.has(projectId)) {
        try {
          await store.ensureScope?.();
          this.scopedTickets.add(projectId);
        } catch (error) {
          this.trackerFailed(projectId, "ensureScope", error);
        }
        signal.throwIfAborted();
      }
      const tickets = await store.list();
      signal.throwIfAborted();
      this.o.stateOwner?.assertOwned();
      await this.o.store.replaceIndexedTickets(projectId, tickets, signal);
      signal.throwIfAborted();
      this.o.stateOwner?.assertOwned();
      this.hydratedTickets.add(projectId);
    }, this.o.stateOwner?.signal);
  }

  private trackerFailed(projectId: string, operation: string, error: unknown): void {
    this.o.bus.publish({
      type: "tracker.failed",
      projectId,
      operation,
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    });
  }

  async getTrackerFailures(projectId: string): Promise<TrackerFailure[]> {
    await this.config(projectId);
    return this.o.trackerHealth?.failures(projectId) ?? [];
  }

  async getQuota(): Promise<QuotaStatus[]> {
    return this.o.reconciler.quotaStatus();
  }

  async createTicket(projectId: string, input: NewTicket): Promise<Ticket> {
    return (await this.ticketStore(projectId)).create(input);
  }

  async updateTicket(projectId: string, id: string, patch: TicketPatch): Promise<Ticket> {
    const store = await this.ticketStore(projectId);
    if (!(await this.getTicket(projectId, id)))
      throw new CoreError("not_found", `ticket ${id} not found`);
    return store.update(id, patch);
  }

  // ── runs ────────────────────────────────────────────────────────────────────────────────────

  private async runView(record: Parameters<typeof toRun>[0]): Promise<Run> {
    const title = await this.o.store.getIndexedTicketTitle(record.projectId, record.ticketId);
    const pending = await this.o.store.getPendingApproval(
      record.projectId,
      record.ticketId,
      record.phase,
    );
    return toRun(record, {
      ...(title !== null ? { title } : {}),
      awaitingApproval: pending?.runId === record.id,
    });
  }

  async listRuns(projectId?: string): Promise<Run[]> {
    const records = await this.o.store.listRuns(projectId ? { projectId } : {});
    return Promise.all(records.map((r) => this.runView(r)));
  }

  async getRun(id: string): Promise<Run | null> {
    const record = await this.o.store.getRun(id);
    return record ? this.runView(record) : null;
  }

  /**
   * Work starts by marking the ticket ready; the reconciler creates the workflow and dispatches the
   * first phase on its next tick (run here immediately). Returns the dispatched run, or a queued
   * placeholder when limits or dependencies hold it back.
   */
  async startRun(
    input: { projectId: string; ticketId: string; phase: Phase },
    _actor: Actor,
  ): Promise<Run> {
    const ticket = await this.getTicket(input.projectId, input.ticketId);
    if (!ticket)
      throw new CoreError("not_found", `ticket ${input.ticketId} not found in this project`);
    if (input.phase !== "spike") {
      throw new CoreError(
        "invalid_state",
        "workflows start at spike; later phases are driven by the reconciler",
      );
    }
    if (ticket.status !== "ready")
      await this.updateTicket(input.projectId, ticket.id, { status: "ready" });
    await this.o.reconciler.tick().catch(translate);
    const runs = await this.o.store.listRuns({
      projectId: input.projectId,
      ticketId: input.ticketId,
    });
    const latest = runs.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()).at(-1);
    if (latest) return this.runView(latest);
    const now = new Date().toISOString();
    return {
      id: `queued:${input.ticketId}`,
      projectId: input.projectId,
      ticketId: input.ticketId,
      ownerId: this.o.reconciler.ownerId,
      phase: "spike",
      state: "queued",
      runner: "pending",
      model: "pending",
      startedAt: now,
      updatedAt: now,
      costUsd: 0,
      title: ticket.title,
    };
  }

  async pauseRun(_id: string): Promise<Run> {
    throw new CoreError("invalid_state", "pausing a run isn't supported by the core yet");
  }

  async cancelRun(_id: string): Promise<Run> {
    throw new CoreError("invalid_state", "cancelling a run isn't supported by the core yet");
  }

  async listReceipts(runId: string): Promise<Receipt[]> {
    if (!(await this.o.store.getRun(runId)))
      throw new CoreError("not_found", `run ${runId} not found`);
    return this.o.store.listReceipts(runId);
  }

  // ── approvals, merge, deploy ────────────────────────────────────────────────────────────────

  async listApprovals(query: { projectId?: string; status?: ApprovalStatus }): Promise<Approval[]> {
    const workflows = await this.o.store.listWorkflows();
    const out: Approval[] = [];
    for (const w of workflows) {
      if (query.projectId && w.projectId !== query.projectId) continue;
      for (const phase of PHASES) {
        for (const record of await this.o.store.listApprovals(w.projectId, w.ticketId, phase)) {
          if (!query.status || record.status === query.status) out.push(toApproval(record));
        }
      }
    }
    return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  async getApproval(id: string): Promise<Approval | null> {
    const record = await this.o.store.getApproval(id);
    return record ? toApproval(record) : null;
  }

  /** The reconciler enforces requester/reconciler/owner, phase, human-only and head-SHA rules. */
  async decideApproval(
    id: string,
    decision: ApprovalDecision,
    by: Actor,
    note?: string,
  ): Promise<Approval> {
    if (!(await this.o.store.getApproval(id)))
      throw new CoreError("not_found", `approval ${id} not found`);
    await this.o.reconciler.decideApproval(id, decision, by, note).catch(translate);
    // An approval unblocks the workflow; let the reconciler continue right away.
    await this.o.reconciler.tick().catch(() => undefined);
    const record = await this.o.store.getApproval(id);
    if (!record) throw new CoreError("not_found", `approval ${id} not found`);
    return toApproval(record);
  }

  /**
   * Merging and deploying are phases the reconciler runs once their approval is granted (merge port
   * and deploy port of the runtime). These calls nudge the reconciler and report the run's state.
   */
  async merge(runId: string, _actor: Actor): Promise<Run> {
    const record = await this.o.store.getRun(runId);
    if (!record) throw new CoreError("not_found", `run ${runId} not found`);
    if (["failed", "cancelled", "timeout"].includes(record.status)) {
      throw new CoreError("invalid_state", `a ${record.status} run can never be merged`);
    }
    await this.o.reconciler.tick().catch(translate);
    const latest = (
      await this.o.store.listRuns({ projectId: record.projectId, ticketId: record.ticketId })
    )
      .filter((r) => r.phase === "merge")
      .at(-1);
    if (!latest)
      throw new CoreError("invalid_state", "no merge has run yet: approve the merge first");
    return this.runView(latest);
  }

  async deploy(projectId: string, _actor: Actor): Promise<{ id: string; state: string }> {
    await this.config(projectId);
    await this.o.reconciler.tick().catch(translate);
    const latest = (await this.o.store.listRuns({ projectId }))
      .filter((r) => r.phase === "deploy")
      .at(-1);
    if (!latest)
      throw new CoreError("invalid_state", "nothing deployed yet: approve a deploy first");
    return { id: latest.id, state: latest.status };
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    return this.o.bus.subscribe((event) => {
      if (event.type === "run.event" && event.event.runId === runId) listener(event.event);
      if (event.type === "run.finished" && event.runId === runId) {
        listener({ runId, at: new Date().toISOString(), kind: "done", message: event.summary });
      }
    });
  }

  // ── knowledge ──────────────────────────────────────────────────────────────────────────────

  async listAdrs(projectId: string): Promise<ServerAdr[]> {
    return this.o.knowledge.adrs((await this.config(projectId)).repoPath);
  }

  async getGraph(projectId: string): Promise<ProductGraph> {
    return this.o.knowledge.graph((await this.config(projectId)).repoPath);
  }

  async getChecks(projectId: string): Promise<CheckResult | null> {
    const project = await this.config(projectId);
    return this.o.knowledge.checks(project.repoPath, project.baseBranch);
  }

  // ── init interview sessions ──────────────────────────────────────────────────────────────────

  async startInit(projectId: string): Promise<InitSession> {
    const project = await this.config(projectId);
    if (project.matrix?.repo)
      throw new CoreError(
        "invalid_state",
        "existing repos skip the init interview: configure them with PATCH /v1/projects/{id}",
      );
    this.o.stateOwner?.assertOwned();
    const session: InitSession = {
      id: randomUUID(),
      projectId,
      answers: { "process.tickets": project.matrix?.tickets.kind ?? DEFAULT_TICKETS.kind },
      state: "in_progress",
      createdAt: new Date().toISOString(),
    };
    this.inits.set(session.id, session);
    this.persist();
    return structuredClone(session);
  }

  async answerInit(sessionId: string, answers: Record<string, unknown>): Promise<InitSession> {
    return this.mutate(`init:${this.inits.get(sessionId)?.projectId ?? sessionId}`, async () => {
      const session = this.inits.get(sessionId);
      if (!session) throw new CoreError("not_found", `init session ${sessionId} not found`);
      if (session.state === "completed")
        throw new CoreError("conflict", "the interview is already finalized");
      const updated = { ...session, answers: { ...session.answers, ...answers } };
      this.inits.set(sessionId, updated);
      this.persist();
      return structuredClone(updated);
    });
  }

  async replaceInitAnswers(
    sessionId: string,
    answers: Record<string, unknown>,
  ): Promise<InitSession> {
    return this.mutate(`init:${this.inits.get(sessionId)?.projectId ?? sessionId}`, async () => {
      const session = this.inits.get(sessionId);
      if (!session) throw new CoreError("not_found", `init session ${sessionId} not found`);
      if (session.state === "completed")
        throw new CoreError("conflict", "the interview is already finalized");
      const updated = { ...session, answers };
      this.inits.set(sessionId, updated);
      this.persist();
      return structuredClone(updated);
    });
  }

  async finalizeInit(
    sessionId: string,
    options: { acceptRecommended?: boolean } = {},
  ): Promise<InitSession> {
    return this.mutate(`init:${this.inits.get(sessionId)?.projectId ?? sessionId}`, async () => {
      const session = this.inits.get(sessionId);
      if (!session) throw new CoreError("not_found", `init session ${sessionId} not found`);
      this.finalizingProjects.add(session.projectId);
      const project = await this.config(session.projectId);
      const expected = resolve(this.o.projectsRoot, project.id);
      if (
        resolve(project.repoPath) !== expected ||
        (await lstat(expected)).isSymbolicLink() ||
        (await realpath(expected)) !== join(await realpath(this.o.projectsRoot), project.id)
      )
        throw new CoreError(
          "forbidden",
          "project repo is outside the allowed directory or uses symlinks",
        );
      const { result, effectiveAnswers } = await finalizeProject({
        stateOwner: this.o.stateOwner,
        sessionId: session.id,
        ...(session.state === "completed" && session.result?.status === "ok"
          ? { completedCommit: session.result.commit }
          : {}),
        project,
        answers: session.answers,
        acceptRecommended: options.acceptRecommended === true,
        store: this.o.store,
        tickets: await this.ticketStore(session.projectId),
        journalFile: this.o.stateFile
          ? join(this.o.projectsRoot, `${project.id}.init.json`)
          : undefined,
      });
      if (result.status === "ok" && (await this.ticketStore(session.projectId)).kind === "markdown")
        await this.syncTickets(session.projectId);
      this.o.stateOwner?.assertOwned();
      const updated: InitSession = {
        ...session,
        ...(result.status === "ok" && effectiveAnswers ? { answers: effectiveAnswers } : {}),
        result,
        state: result.status === "ok" ? "completed" : "in_progress",
      };
      this.inits.set(sessionId, updated);
      this.persist();
      this.finalizingProjects.delete(session.projectId);
      return structuredClone(updated);
    });
  }

  async getInit(sessionId: string): Promise<InitSession | null> {
    return structuredClone(this.inits.get(sessionId) ?? null);
  }

  // ── settings, monitor, Orca, gateway ─────────────────────────────────────────────────────────

  async getSettings(): Promise<Record<string, unknown>> {
    return this.settings;
  }

  async updateSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.o.stateOwner?.assertOwned();
    this.settings = { ...this.settings, ...patch };
    this.persist();
    return this.settings;
  }

  ingestSignal(signal: MonitorSignal): Promise<{ id: string }> {
    return this.o.monitor.ingest(signal);
  }

  listIncidents(query: { projectId?: string; status?: IncidentStatus }): Promise<Incident[]> {
    return this.o.monitor.incidents(query);
  }

  async getModelHealth(): Promise<ModelHealth[]> {
    return this.modelHealth;
  }

  async getOrcaRuntime(): Promise<OrcaRuntime> {
    const latest = new Map<string, OrcaStatus>();
    for (const status of this.orca) latest.set(status.worktree, status);
    const last = this.orca.at(-1);
    return {
      status: last ? "healthy" : "unknown",
      activeWorktrees: [...latest.values()].filter(
        (s) => !["done", "idle", "failed", "cancelled"].includes(s.status),
      ).length,
      ...(last ? { lastSeen: last.receivedAt } : {}),
    };
  }

  async recordOrcaStatus(status: OrcaStatus): Promise<void> {
    this.orca.push(status);
    if (this.orca.length > 5000) this.orca.shift();
  }
}

export const ALL_PHASES = PHASES;
export type { Actor, Approval, ApprovalDecision, ApprovalStatus, OrcaRuntime, RunEvent };
