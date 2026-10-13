import type { AutonomyMode, Phase } from "@matrix/core";
import { AutonomyConflictError, publicQaReceipt } from "@matrix/core";
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
  type IncidentStatus,
  type Project,
  type Run,
} from "./core-port.js";
import { initProgress, reviseAnswer, validateAnswers } from "./init-progress.js";
import { autonomyEtag, settingsEtag } from "./settings-etag.js";

export type RunView = Run & {
  approval: {
    state: "none" | "pending" | "approved" | "rejected";
    approvalId?: string;
    phase?: Phase;
  };
};

async function core<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AutonomyConflictError)
      throw new HttpError(412, "precondition_failed", error.message);
    if (error instanceof CoreError) {
      if (error.code === "tracker_unavailable") throw new HttpError(503, error.code, error.message);
      const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409;
      throw new HttpError(status, error.code, error.message);
    }
    throw error;
  }
}

/** Every capability exposed over REST and MCP goes through here, so both share one authorization path. */
export class Operations {
  private settingsLock: Promise<unknown> = Promise.resolve();

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
    input: {
      name: string;
      description: string;
      workspace: Project["workspace"];
      tickets?: { kind: "beads" | "markdown" | "github"; repo?: string };
      checks?: { kind: "typecheck" | "lint" | "test" | "adr-check"; cmd: string[] }[];
    },
  ) {
    return this.op(p, "admin", "/projects")(() => this.core.createProject(input));
  }

  getProjectPolicy(p: Principal, projectId: string) {
    return this.op(
      p,
      "read",
      `/projects/${projectId}`,
      projectId,
    )(async () => {
      const snapshot = await this.core.getProjectPolicy(projectId);
      if (!snapshot) throw new CoreError("not_found", `project ${projectId} not found`);
      return snapshot;
    });
  }

  setAutonomy(p: Principal, projectId: string, phase: Phase, mode: AutonomyMode) {
    return this.op(
      p,
      "admin",
      `/projects/${projectId}/autonomy`,
      projectId,
    )(() => this.core.setAutonomy(projectId, phase, mode, this.actor(p)));
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
    const visible = scope === "*" ? runs : runs.filter((run) => scope.includes(run.projectId));
    return Promise.all(visible.map((run) => this.withApproval(run)));
  }

  /** Adds the run's latest approval state, which the dashboard shows on every run row. */
  private async withApproval(run: Run): Promise<RunView> {
    const approvals = (await this.core.listApprovals({ projectId: run.projectId })).filter(
      (a) => a.runId === run.id,
    );
    const latest = approvals.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)).at(-1);
    return {
      ...run,
      approval: latest
        ? { state: latest.status, approvalId: latest.id, phase: latest.phase }
        : { state: "none" },
    };
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
      return this.withApproval(run);
    });
  }

  startRun(p: Principal, input: { projectId: string; ticketId: string; phase: Phase }) {
    return this.op(p, "runs:start", "/runs", input.projectId, { budget: "runs" })(() =>
      this.core.startRun(input, this.actor(p)).then((run) => this.withApproval(run)),
    );
  }

  async pauseRun(p: Principal, id: string) {
    const projectId = await this.projectOfRun(id);
    return this.op(
      p,
      "runs:start",
      `/runs/${id}/pause`,
      projectId,
    )(() => this.core.pauseRun(id).then((run) => this.withApproval(run)));
  }

  async cancelRun(p: Principal, id: string) {
    const projectId = await this.projectOfRun(id);
    return this.op(
      p,
      "runs:start",
      `/runs/${id}/cancel`,
      projectId,
    )(() => this.core.cancelRun(id).then((run) => this.withApproval(run)));
  }

  async listReceipts(p: Principal, runId: string) {
    const projectId = await this.projectOfRun(runId);
    return this.op(
      p,
      "read",
      `/runs/${runId}/receipts`,
      projectId,
    )(async () => (await this.core.listReceipts(runId)).map(publicQaReceipt));
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
      return this.core.decideApproval(id, decision, this.actor(p), note);
    });
  }

  async merge(p: Principal, runId: string) {
    const projectId = await this.projectOfRun(runId);
    return this.op(
      p,
      "merge",
      `/runs/${runId}/merge`,
      projectId,
    )(() => this.core.merge(runId, this.actor(p)).then((run) => this.withApproval(run)));
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

  /** One call for the dashboard's factory overview, filtered to the key's projects. */
  async getOverview(p: Principal) {
    const [projects, runs, approvals, incidents] = await Promise.all([
      this.listProjects(p),
      this.listRuns(p),
      this.listApprovals(p, { status: "pending" }),
      this.listIncidents(p, { status: "open" }),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const active = runs.filter((r) => r.state === "running" || r.state === "awaiting_approval");
    return {
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        workspace: project.workspace,
        activeRuns: active.filter((r) => r.projectId === project.id).length,
        openIncidents: incidents.filter((i) => i.projectId === project.id).length,
      })),
      activeRuns: active.length,
      queuedRuns: runs.filter((r) => r.state === "queued").length,
      costTodayUsd:
        Math.round(
          runs.filter((r) => r.startedAt.startsWith(today)).reduce((sum, r) => sum + r.costUsd, 0) *
            100,
        ) / 100,
      pendingApprovals: approvals.length,
      openIncidents: incidents.length,
    };
  }

  async listIncidents(p: Principal, query: { projectId?: string; status?: IncidentStatus }) {
    const incidents = await this.op(
      p,
      "read",
      "/incidents",
      query.projectId ?? { kind: "list" },
    )(() => this.core.listIncidents(query));
    const scope = p.key.scope.projects;
    // Unattributed incidents (global webhook secrets) are only visible to all-projects keys.
    return scope === "*"
      ? incidents
      : incidents.filter((i) => i.projectId !== undefined && scope.includes(i.projectId));
  }

  /** Integration status for the dashboard; never includes secret values. */
  getIntegrations(
    p: Principal,
    webhooks: Record<"sentry" | "github" | "posthog" | "otel" | "orca", boolean>,
  ) {
    return this.op(p, "read", "/integrations", { kind: "list" })(async () => {
      const [models, orca] = await Promise.all([
        this.core.getModelHealth(),
        this.core.getOrcaRuntime(),
      ]);
      const pill = (ok: boolean | "degraded") =>
        ok === "degraded"
          ? { label: "degraded", tone: "amber" as const }
          : ok
            ? { label: "connected", tone: "green" as const }
            : { label: "not configured", tone: "neutral" as const };
      const healthy = models.filter((m) => m.status === "ok").length;
      return [
        {
          name: "Model gateway",
          detail: models.length
            ? `${healthy} of ${models.length} model routes healthy`
            : "no model routes reported",
          status:
            models.length === 0
              ? pill(false)
              : healthy === models.length
                ? pill(true)
                : pill("degraded"),
        },
        {
          name: "Orca",
          detail: orca.lastSeen
            ? `${orca.activeWorktrees} active worktrees`
            : "no agent hook received yet",
          status:
            orca.status === "healthy"
              ? pill(true)
              : orca.status === "degraded"
                ? pill("degraded")
                : pill(false),
        },
        { name: "Sentry", detail: "webhook /hooks/sentry (HMAC)", status: pill(webhooks.sentry) },
        { name: "GitHub", detail: "webhook /hooks/github (HMAC)", status: pill(webhooks.github) },
        {
          name: "PostHog",
          detail: "webhook /hooks/posthog (shared secret)",
          status: pill(webhooks.posthog),
        },
        {
          name: "OpenTelemetry",
          detail: "alerts /hooks/otel (shared secret)",
          status: pill(webhooks.otel),
        },
        {
          name: "Orca agent hooks",
          detail: "/hooks/orca (shared secret)",
          status: pill(webhooks.orca),
        },
      ];
    });
  }

  getModelHealth(p: Principal) {
    return this.op(p, "read", "/gateway/health", { kind: "list" })(() =>
      this.core.getModelHealth(),
    );
  }

  getOrcaRuntime(p: Principal) {
    return this.op(p, "read", "/orca/runtime", { kind: "list" })(() => this.core.getOrcaRuntime());
  }

  /** Audited admin check on one project, for actions that don't go through the core. */
  async authorizeProjectAdmin(p: Principal, projectId: string, path: string) {
    await this.op(
      p,
      "admin",
      path,
      projectId,
    )(async () => {
      if (!(await this.core.getProject(projectId)))
        throw new CoreError("not_found", `project ${projectId} not found`);
    });
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

  /** Contradictions are re-checked server-side; any error-level one refuses finalize with 409. */
  async finalizeInit(
    p: Principal,
    sessionId: string,
    options: { acceptRecommended?: boolean } = {},
  ) {
    const session = await core(() => this.core.getInit(sessionId));
    if (!session) throw new HttpError(404, "not_found", `init session ${sessionId} not found`);
    return this.op(
      p,
      "admin",
      `/init/${sessionId}/finalize`,
      session.projectId,
    )(async () => {
      const errors = initProgress(session.answers).contradictions.filter(
        (c) => c.severity === "error",
      );
      if (errors.length > 0 && session.state !== "completed") {
        throw new HttpError(
          409,
          "contradictions",
          errors.map((c) => c.message).join("; "),
          undefined,
          errors,
        );
      }
      const finalized = await this.core.finalizeInit(sessionId, options);
      if (finalized.result?.status === "contradictions") {
        throw new HttpError(
          409,
          "contradictions",
          finalized.result.contradictions.map((c) => c.message).join("; "),
          undefined,
          finalized.result.contradictions,
        );
      }
      return finalized;
    });
  }

  /** Changes a confirmed answer; dependent and no-longer-applicable answers are dropped. */
  async reviseInitAnswer(p: Principal, sessionId: string, questionId: string, value: unknown) {
    const session = await core(() => this.core.getInit(sessionId));
    if (!session) throw new HttpError(404, "not_found", `init session ${sessionId} not found`);
    return this.op(
      p,
      "admin",
      `/init/${sessionId}/answers/${questionId}`,
      session.projectId,
    )(async () => {
      const { answers, dropped } = reviseAnswer(session.answers, questionId, value);
      const updated = await this.core.replaceInitAnswers(sessionId, answers);
      return { session: updated, dropped, progress: initProgress(updated.answers) };
    });
  }

  /** Every phase's autonomy in one atomic write, guarded by the project's autonomy ETag. */
  async setAutonomyPolicy(
    p: Principal,
    projectId: string,
    policy: Partial<Record<Phase, AutonomyMode>>,
    ifMatch: string | undefined,
  ) {
    if (ifMatch === undefined) {
      throw new HttpError(
        428,
        "precondition_required",
        "send If-Match with the project's autonomy ETag",
      );
    }
    return this.op(
      p,
      "admin",
      `/projects/${projectId}/autonomy-policy`,
      projectId,
    )(() => {
      const write = this.settingsLock.then(async () => {
        const snapshot = await this.core.getProjectPolicy(projectId);
        if (!snapshot) throw new CoreError("not_found", `project ${projectId} not found`);
        if (ifMatch !== autonomyEtag(snapshot)) {
          throw new HttpError(412, "precondition_failed", "autonomy changed since you loaded it");
        }
        await this.core.setAutonomyPolicy(projectId, policy, this.actor(p), snapshot.version);
        return this.core.getProjectPolicy(projectId);
      });
      this.settingsLock = write.catch(() => undefined);
      return write;
    });
  }

  async getInitContradictions(p: Principal, sessionId: string) {
    const session = await this.getInit(p, sessionId);
    return initProgress(session.answers).contradictions;
  }

  async getInitProgress(p: Principal, sessionId: string) {
    const session = await this.getInit(p, sessionId);
    return initProgress(session.answers);
  }

  getChecks(p: Principal, projectId: string) {
    return this.op(
      p,
      "read",
      `/projects/${projectId}/checks`,
      projectId,
    )(async () => {
      const checks = await this.core.getChecks(projectId);
      return checks ?? { ref: "", violations: [] };
    });
  }

  async answerInit(p: Principal, sessionId: string, answers: Record<string, unknown>) {
    validateAnswers(answers);
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

  /**
   * Compare-and-set: the write requires `If-Match` (428 without it) and only happens if the settings
   * still have that ETag (412 otherwise). Writes are serialized so two concurrent PATCHes can't both pass the check.
   */
  updateSettings(p: Principal, patch: Record<string, unknown>, ifMatch?: string) {
    return this.op(
      p,
      "admin",
      "/settings",
    )(() => {
      const write = this.settingsLock.then(async () => {
        if (ifMatch === undefined) {
          throw new HttpError(428, "precondition_required", "send If-Match with the settings ETag");
        }
        {
          const current = settingsEtag(await this.core.getSettings());
          const wanted = ifMatch.replace(/^W\//, "");
          if (wanted !== "*" && wanted !== current) {
            throw new HttpError(
              412,
              "precondition_failed",
              "settings changed since you loaded them",
            );
          }
        }
        return this.core.updateSettings(patch);
      });
      this.settingsLock = write.catch(() => undefined);
      return write;
    });
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
      return this.keys.create({ ...input, kind: input.kind ?? "agent", createdByKeyId: p.key.id });
    });
  }

  /** Renames a key or tightens/loosens its budget and rate limit, never beyond the caller's own. */
  updateKey(
    p: Principal,
    id: string,
    patch: { name?: string; budget?: KeyBudget; ratePerMinute?: number },
  ) {
    return this.op(
      p,
      "admin",
      `/keys/${id}`,
    )(async () => {
      const current = this.keys.get(id);
      if (!current || current.revokedAt) throw new CoreError("not_found", `key ${id} not found`);
      const problem = withinLimits(p.key, {
        scope: current.scope,
        budget: patch.budget ?? current.budget,
        ratePerMinute: patch.ratePerMinute ?? current.ratePerMinute,
      });
      if (problem) throw new HttpError(403, "forbidden", problem);
      const updated = this.keys.update(id, patch);
      if (!updated) throw new CoreError("not_found", `key ${id} not found`);
      return updated;
    });
  }

  revokeKey(p: Principal, id: string) {
    const admin = p.key.scope.actions.includes("admin");
    return this.op(
      p,
      admin ? "admin" : (p.key.scope.actions[0] ?? "admin"),
      `/keys/${id}`,
      { kind: "list" },
      { mutating: true, method: "DELETE" },
    )(async () => {
      const current = this.keys.get(id);
      if (!current || current.revokedAt) throw new CoreError("not_found", `key ${id} not found`);
      if (
        p.key.kind === "agent" &&
        (current.kind === "human" || current.scope.actions.includes("admin"))
      )
        throw new HttpError(403, "forbidden", "agent keys cannot revoke human or admin keys");
      const owner = current.id === p.key.id || current.createdByKeyId === p.key.id;
      if (!admin && !owner)
        throw new HttpError(403, "forbidden", "only an admin or the key owner can revoke a key");
      const scope = p.key.scope.projects;
      if (
        scope !== "*" &&
        (current.scope.projects === "*" ||
          current.scope.projects.some((project) => !scope.includes(project)))
      )
        throw new HttpError(403, "forbidden", "cannot revoke a key outside your project scope");
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
