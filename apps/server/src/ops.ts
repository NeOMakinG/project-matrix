import type { AutonomyMode, Phase } from "@matrix/core";
import type { NewTicket, TicketPatch, TicketQuery } from "@matrix/tickets";
import { type Guard, type GuardedOp, HttpError, type Principal } from "./auth/guard.js";
import {
  type Action,
  type KeyBudget,
  type KeyKind,
  type KeyScope,
  type KeyStore,
  type OpScope,
  withinLimits,
} from "./auth/keys.js";
import type { AuditLog } from "./auth/limits.js";
import {
  type Actor,
  type ApprovalDecision,
  type ApprovalStatus,
  CoreError,
  type CorePort,
  type Project,
} from "./core-port.js";

async function core<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CoreError) {
      const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409;
      throw new HttpError(status, error.code, error.message);
    }
    throw error;
  }
}

/** Every capability exposed over REST and MCP goes through here, so both share one authorization path. */
export class Operations {
  constructor(
    readonly core: CorePort,
    private readonly guard: Guard,
    private readonly keys: KeyStore,
    private readonly audit: AuditLog,
  ) {}

  /**
   * `target` is a project id, an explicit scope, or omitted. Omitted means factory-wide, which requires
   * a key covering every project: the safe default for anything not tied to one project.
   */
  private op(
    p: Principal,
    action: Action,
    path: string,
    target?: string | OpScope,
    extra: Partial<GuardedOp> = {},
  ) {
    const mutating = action !== "read";
    const scope: OpScope =
      target === undefined
        ? { kind: "global" }
        : typeof target === "string"
          ? { kind: "project", projectId: target }
          : target;
    return <T>(fn: () => Promise<T>) =>
      this.guard.run(
        p,
        { action, mutating, method: mutating ? "POST" : "GET", path, target: scope, ...extra },
        () => core(fn),
      );
  }

  private actor(p: Principal): Actor {
    return { id: `key:${p.key.id}`, kind: p.key.kind };
  }

  private async projectOfRun(runId: string): Promise<string> {
    const run = await core(() => this.core.getRun(runId));
    if (!run) throw new HttpError(404, "not_found", `run ${runId} not found`);
    return run.projectId;
  }

  async listProjects(p: Principal): Promise<Project[]> {
    const projects = await this.op(p, "read", "/projects", { kind: "list" })(() =>
      this.core.listProjects(),
    );
    const scope = p.key.scope.projects;
    return scope === "*" ? projects : projects.filter((project) => scope.includes(project.id));
  }

  getProject(p: Principal, id: string) {
    return this.op(
      p,
      "read",
      `/projects/${id}`,
      id,
    )(async () => {
      const project = await this.core.getProject(id);
      if (!project) throw new CoreError("not_found", `project ${id} not found`);
      return project;
    });
  }

  createProject(
    p: Principal,
    input: { name: string; description: string; workspace: Project["workspace"] },
  ) {
    return this.op(p, "admin", "/projects")(() => this.core.createProject(input));
  }

  setAutonomy(p: Principal, projectId: string, phase: Phase, mode: AutonomyMode) {
    return this.op(
      p,
      "admin",
      `/projects/${projectId}/autonomy`,
      projectId,
    )(() => this.core.setAutonomy(projectId, phase, mode));
  }

  listTickets(p: Principal, projectId: string, query?: TicketQuery) {
    return this.op(
      p,
      "read",
      `/projects/${projectId}/tickets`,
      projectId,
    )(() => this.core.listTickets(projectId, query));
  }

  createTicket(p: Principal, projectId: string, input: NewTicket) {
    return this.op(
      p,
      "tickets:write",
      `/projects/${projectId}/tickets`,
      projectId,
    )(() => this.core.createTicket(projectId, input));
  }

  updateTicket(p: Principal, projectId: string, id: string, patch: TicketPatch) {
    return this.op(
      p,
      "tickets:write",
      `/projects/${projectId}/tickets/${id}`,
      projectId,
    )(() => this.core.updateTicket(projectId, id, patch));
  }

  async listRuns(p: Principal, projectId?: string) {
    const runs = await this.op(
      p,
      "read",
      "/runs",
      projectId ?? { kind: "list" },
    )(() => this.core.listRuns(projectId));
    const scope = p.key.scope.projects;
    return scope === "*" ? runs : runs.filter((run) => scope.includes(run.projectId));
  }

  async getRun(p: Principal, id: string) {
    const projectId = await this.projectOfRun(id);
    return this.op(
      p,
      "read",
      `/runs/${id}`,
      projectId,
    )(async () => {
      const run = await this.core.getRun(id);
      if (!run) throw new CoreError("not_found", `run ${id} not found`);
      return run;
    });
  }

  startRun(p: Principal, input: { projectId: string; ticketId: string; phase: Phase }) {
    return this.op(p, "runs:start", "/runs", input.projectId, { budget: "runs" })(() =>
      this.core.startRun(input, this.actor(p)),
    );
  }

  async pauseRun(p: Principal, id: string) {
    const projectId = await this.projectOfRun(id);
    return this.op(p, "runs:start", `/runs/${id}/pause`, projectId)(() => this.core.pauseRun(id));
  }

  async cancelRun(p: Principal, id: string) {
    const projectId = await this.projectOfRun(id);
    return this.op(p, "runs:start", `/runs/${id}/cancel`, projectId)(() => this.core.cancelRun(id));
  }

  async listReceipts(p: Principal, runId: string) {
    const projectId = await this.projectOfRun(runId);
    return this.op(
      p,
      "read",
      `/runs/${runId}/receipts`,
      projectId,
    )(() => this.core.listReceipts(runId));
  }

  async listApprovals(p: Principal, query: { projectId?: string; status?: ApprovalStatus }) {
    const approvals = await this.op(
      p,
      "read",
      "/approvals",
      query.projectId ?? { kind: "list" },
    )(() => this.core.listApprovals(query));
    const scope = p.key.scope.projects;
    return scope === "*" ? approvals : approvals.filter((a) => scope.includes(a.projectId));
  }

  /**
   * Decisions are recorded under `key:<id>`. Core refuses the requester, reconcilers and the run owner;
   * on top of that, a phase in `human` autonomy only accepts decisions from human keys.
   */
  async decideApproval(p: Principal, id: string, decision: ApprovalDecision, note?: string) {
    const approval = await core(() => this.core.getApproval(id));
    if (!approval) throw new HttpError(404, "not_found", `approval ${id} not found`);
    return this.op(
      p,
      "runs:approve",
      `/approvals/${id}/decision`,
      approval.projectId,
    )(async () => {
      const project = await this.core.getProject(approval.projectId);
      if (project?.autonomy[approval.phase] === "human" && p.key.kind !== "human") {
        throw new CoreError("forbidden", "this phase requires a decision from a human key");
      }
      return this.core.decideApproval(id, decision, this.actor(p).id, note);
    });
  }

  async merge(p: Principal, runId: string) {
    const projectId = await this.projectOfRun(runId);
    return this.op(
      p,
      "merge",
      `/runs/${runId}/merge`,
      projectId,
    )(() => this.core.merge(runId, this.actor(p)));
  }

  deploy(p: Principal, projectId: string) {
    return this.op(
      p,
      "deploy",
      `/projects/${projectId}/deploy`,
      projectId,
    )(() => this.core.deploy(projectId, this.actor(p)));
  }

  async authorizeRunStream(p: Principal, runId: string) {
    const projectId = await this.projectOfRun(runId);
    await this.op(p, "read", `/runs/${runId}/events`, projectId)(async () => undefined);
  }

  listAdrs(p: Principal, projectId: string) {
    return this.op(
      p,
      "read",
      `/projects/${projectId}/adrs`,
      projectId,
    )(() => this.core.listAdrs(projectId));
  }

  getGraph(p: Principal, projectId: string) {
    return this.op(
      p,
      "read",
      `/projects/${projectId}/graph`,
      projectId,
    )(() => this.core.getGraph(projectId));
  }

  startInit(p: Principal, projectId: string) {
    return this.op(
      p,
      "admin",
      `/projects/${projectId}/init`,
      projectId,
    )(() => this.core.startInit(projectId));
  }

  async answerInit(p: Principal, sessionId: string, answers: Record<string, unknown>) {
    const session = await core(() => this.core.getInit(sessionId));
    if (!session) throw new HttpError(404, "not_found", `init session ${sessionId} not found`);
    return this.op(
      p,
      "admin",
      `/init/${sessionId}`,
      session.projectId,
    )(() => this.core.answerInit(sessionId, answers));
  }

  async getInit(p: Principal, sessionId: string) {
    const session = await core(() => this.core.getInit(sessionId));
    if (!session) throw new HttpError(404, "not_found", `init session ${sessionId} not found`);
    return this.op(p, "read", `/init/${sessionId}`, session.projectId)(async () => session);
  }

  getSettings(p: Principal) {
    return this.op(p, "admin", "/settings", undefined, { mutating: false, method: "GET" })(() =>
      this.core.getSettings(),
    );
  }

  updateSettings(p: Principal, patch: Record<string, unknown>) {
    return this.op(p, "admin", "/settings")(() => this.core.updateSettings(patch));
  }

  listKeys(p: Principal) {
    return this.op(p, "admin", "/keys", undefined, { mutating: false, method: "GET" })(async () =>
      this.keys.list(),
    );
  }

  /**
   * Any admin key may mint keys, but never wider than itself: projects, actions, budgets and rate
   * limit must all fit inside the creator's own (a project-scoped admin can't mint a global key).
   */
  createKey(
    p: Principal,
    input: {
      name: string;
      scope: KeyScope;
      kind?: KeyKind;
      budget?: KeyBudget;
      ratePerMinute?: number;
    },
  ) {
    const target: OpScope = input.scope.projects === "*" ? { kind: "global" } : { kind: "list" };
    return this.op(
      p,
      "admin",
      "/keys",
      target,
    )(async () => {
      const problem = withinLimits(p.key, {
        scope: input.scope,
        budget: input.budget ?? {},
        ratePerMinute: input.ratePerMinute ?? 120,
      });
      if (problem) throw new HttpError(403, "forbidden", problem);
      if (input.kind === "human" && p.key.kind !== "human") {
        throw new HttpError(403, "forbidden", "only human keys can mint human keys");
      }
      return this.keys.create({ ...input, kind: input.kind ?? "agent" });
    });
  }

  revokeKey(p: Principal, id: string) {
    return this.op(
      p,
      "admin",
      `/keys/${id}`,
    )(async () => {
      if (!this.keys.revoke(id)) throw new CoreError("not_found", `key ${id} not found`);
      return { id, revoked: true };
    });
  }

  listAudit(p: Principal, filter: { keyId?: string; projectId?: string }) {
    return this.op(p, "admin", "/audit", undefined, { mutating: false, method: "GET" })(async () =>
      this.audit.list(filter),
    );
  }
}
