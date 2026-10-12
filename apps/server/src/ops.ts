import type { AutonomyMode, Phase } from "@matrix/core";
import type { NewTicket, TicketPatch, TicketQuery } from "@matrix/tickets";
import { type Guard, type GuardedOp, HttpError, type Principal } from "./auth/guard.js";
import type { Action, KeyBudget, KeyScope, KeyStore } from "./auth/keys.js";
import type { AuditLog } from "./auth/limits.js";
import { type ApprovalDecision, CoreError, type CorePort, type Project } from "./core-port.js";

async function core<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CoreError) {
      const status = error.code === "not_found" ? 404 : 409;
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

  private op(
    p: Principal,
    action: Action,
    path: string,
    projectId?: string,
    extra: Partial<GuardedOp> = {},
  ) {
    const mutating = action !== "read";
    return <T>(fn: () => Promise<T>) =>
      this.guard.run(
        p,
        {
          action,
          mutating,
          method: mutating ? "POST" : "GET",
          path,
          ...(projectId ? { projectId } : {}),
          ...extra,
        },
        () => core(fn),
      );
  }

  private async projectOfRun(runId: string): Promise<string> {
    const run = await core(() => this.core.getRun(runId));
    if (!run) throw new HttpError(404, "not_found", `run ${runId} not found`);
    return run.projectId;
  }

  async listProjects(p: Principal): Promise<Project[]> {
    const projects = await this.op(p, "read", "/projects")(() => this.core.listProjects());
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
    const runs = await this.op(p, "read", "/runs", projectId)(() => this.core.listRuns(projectId));
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
      this.core.startRun(input),
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

  async approve(p: Principal, runId: string, decision: ApprovalDecision, comment?: string) {
    const projectId = await this.projectOfRun(runId);
    return this.op(
      p,
      "runs:approve",
      `/runs/${runId}/approval`,
      projectId,
    )(() => this.core.approve(runId, decision, p.key.id, comment));
  }

  async merge(p: Principal, runId: string) {
    const projectId = await this.projectOfRun(runId);
    return this.op(
      p,
      "merge",
      `/runs/${runId}/merge`,
      projectId,
    )(() => this.core.merge(runId, p.key.id));
  }

  deploy(p: Principal, projectId: string) {
    return this.op(
      p,
      "deploy",
      `/projects/${projectId}/deploy`,
      projectId,
    )(() => this.core.deploy(projectId, p.key.id));
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

  createKey(
    p: Principal,
    input: { name: string; scope: KeyScope; budget?: KeyBudget; ratePerMinute?: number },
  ) {
    return this.op(p, "admin", "/keys")(async () => this.keys.create(input));
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
