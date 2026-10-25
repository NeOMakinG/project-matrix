import { fileURLToPath } from "node:url";
import type { Ticket } from "@matrix/tickets";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { AutonomyMode, Phase, Receipt, RunEvent } from "../ports.js";
import { PHASES } from "../ports.js";
import {
  type ApprovalRecord,
  type Approver,
  type AutonomyChange,
  AutonomyConflictError,
  type LabelRetry,
  type Lesson,
  projectPolicySnapshot,
  type RunRecord,
  type RunRecordStatus,
  type StepRecord,
  type Store,
  VersionConflictError,
} from "../store.js";
import type { ProjectConfig, WorkflowState } from "../types.js";
import { fenceDatabase } from "./ownership-fence.js";
import * as s from "./schema.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

type Db = PostgresJsDatabase<typeof s>;

const opt = <K extends string, V>(k: K, v: V | null | undefined): { [P in K]?: V } =>
  (v === null || v === undefined ? {} : { [k]: v }) as { [P in K]?: V };

function toWorkflow(r: typeof s.workflows.$inferSelect): WorkflowState {
  return {
    projectId: r.projectId,
    ticketId: r.ticketId,
    phase: r.phase as Phase,
    status: r.status as WorkflowState["status"],
    attempt: r.attempt,
    loops: r.loops,
    priority: r.priority,
    version: r.version,
    ...opt("implementerModel", r.implementerModel),
    ...opt("workspaceRef", r.workspaceRef),
    ...opt("workdir", r.workdir),
    ...opt("lastError", r.lastError),
    ...opt("nextAttemptAt", r.nextAttemptAt),
    ...opt("currentRunId", r.currentRunId),
    ...opt("leaseOwner", r.leaseOwner),
    ...opt("leaseExpiresAt", r.leaseExpiresAt),
    ...opt("reviewedTree", r.reviewedTree),
    ...(r.generation ? { generation: r.generation } : {}),
    ...opt("requeuedAt", r.requeuedAt),
    ...(r.requeueCount ? { requeueCount: r.requeueCount } : {}),
    ...(r.stoppedBy === "human" ? { stoppedBy: "human" as const } : {}),
  };
}

function toRun(r: typeof s.runs.$inferSelect): RunRecord {
  return {
    id: r.id,
    projectId: r.projectId,
    ticketId: r.ticketId,
    phase: r.phase as Phase,
    attempt: r.attempt,
    stepKey: r.stepKey,
    host: r.host,
    ownerId: r.ownerId,
    ...opt("headSha", r.headSha),
    status: r.status as RunRecordStatus,
    startedAt: r.startedAt,
    lastEventAt: r.lastEventAt,
    heartbeatAt: r.heartbeatAt,
    ...opt("runner", r.runner as RunRecord["runner"] | null),
    ...opt("model", r.model),
    ...opt("summary", r.summary),
    ...opt("inputTokens", r.inputTokens),
    ...opt("outputTokens", r.outputTokens),
    ...opt("costUsd", r.costUsd),
    ...opt("finishedAt", r.finishedAt),
  };
}

function toApproval(r: typeof s.approvals.$inferSelect): ApprovalRecord {
  return {
    id: r.id,
    projectId: r.projectId,
    ticketId: r.ticketId,
    phase: r.phase as Phase,
    runId: r.runId,
    headSha: r.headSha,
    requestedBy: r.requestedBy,
    status: r.status as ApprovalRecord["status"],
    requestedAt: r.requestedAt,
    ...opt("decidedAt", r.decidedAt),
    ...opt("decidedBy", r.decidedBy),
    ...opt("decidedByKind", r.decidedByKind as ApprovalRecord["decidedByKind"] | null),
    ...opt("note", r.note),
  };
}

export class PgStore implements Store {
  private constructor(
    private readonly client: postgres.Sql,
    private readonly db: Db,
    private readonly detachOwnership?: () => void,
  ) {}

  static async connect(
    url: string,
    options: { migrate?: boolean; assertOwned?: () => void; signal?: AbortSignal } = {},
  ): Promise<PgStore> {
    options.assertOwned?.();
    const client = postgres(url, { max: 10, onnotice: () => undefined });
    const abort = () => {
      void client.end({ timeout: 0 }).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const rawDb = drizzle(client, { schema: s });
    const db = options.assertOwned ? fenceDatabase(rawDb, options.assertOwned) : rawDb;
    try {
      if (options.migrate !== false) {
        const migrationLock = await client.reserve();
        try {
          options.assertOwned?.();
          await migrationLock`select pg_advisory_lock(1296127058)`;
          options.assertOwned?.();
          await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
        } finally {
          await migrationLock`select pg_advisory_unlock(1296127058)`;
          migrationLock.release();
        }
      }
    } catch (error) {
      options.signal?.removeEventListener("abort", abort);
      await client.end({ timeout: 5 });
      throw error;
    }
    options.assertOwned?.();
    return new PgStore(client, db, () => options.signal?.removeEventListener("abort", abort));
  }

  async close(): Promise<void> {
    this.detachOwnership?.();
    await this.client.end({ timeout: 5 });
  }

  async upsertProject(config: ProjectConfig) {
    const row = {
      id: config.id,
      name: config.name,
      repoPath: config.repoPath,
      baseBranch: config.baseBranch,
      config,
    };
    await this.db
      .insert(s.projects)
      .values(row)
      .onConflictDoUpdate({ target: s.projects.id, set: { ...row, updatedAt: new Date() } });
  }

  async getProject(id: string) {
    const [row] = await this.db.select().from(s.projects).where(eq(s.projects.id, id));
    return row ? this.withAutonomy(row.config as ProjectConfig) : null;
  }

  async listProjects() {
    const rows = await this.db.select().from(s.projects).orderBy(asc(s.projects.id));
    return Promise.all(rows.map((r) => this.withAutonomy(r.config as ProjectConfig)));
  }

  private async withAutonomy(config: ProjectConfig): Promise<ProjectConfig> {
    const rows = await this.db
      .select()
      .from(s.autonomySettings)
      .where(eq(s.autonomySettings.projectId, config.id));
    const autonomy = { ...config.autonomy };
    for (const r of rows) {
      if (r.phase === "default") autonomy.default = r.mode as ProjectConfig["autonomy"]["default"];
      else autonomy[r.phase as Phase] = r.mode as ProjectConfig["autonomy"]["default"];
    }
    return { ...config, autonomy };
  }

  async indexTicket(projectId: string, t: Parameters<Store["indexTicket"]>[1]) {
    const row = {
      projectId,
      ticketId: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority ?? null,
      labels: t.labels,
      url: t.url ?? null,
      syncedAt: new Date(),
      ...(t.snapshot ? { snapshot: t.snapshot } : {}),
    };
    await this.db
      .insert(s.ticketIndex)
      .values(row)
      .onConflictDoUpdate({ target: [s.ticketIndex.projectId, s.ticketIndex.ticketId], set: row });
  }

  async getIndexedTicketTitle(projectId: string, ticketId: string) {
    const [row] = await this.db
      .select({ title: s.ticketIndex.title })
      .from(s.ticketIndex)
      .where(and(eq(s.ticketIndex.projectId, projectId), eq(s.ticketIndex.ticketId, ticketId)));
    return row?.title ?? null;
  }
  async replaceIndexedTickets(projectId: string, tickets: Ticket[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.db.transaction(async (tx) => {
      await tx
        .update(s.ticketIndex)
        .set({ snapshot: null })
        .where(eq(s.ticketIndex.projectId, projectId));
      for (const ticket of tickets) {
        signal?.throwIfAborted();
        const row = {
          projectId,
          ticketId: ticket.id,
          title: ticket.title,
          status: ticket.status,
          priority: ticket.priority ?? null,
          labels: ticket.labels,
          url: ticket.url ?? null,
          syncedAt: new Date(),
          snapshot: ticket,
        };
        await tx
          .insert(s.ticketIndex)
          .values(row)
          .onConflictDoUpdate({
            target: [s.ticketIndex.projectId, s.ticketIndex.ticketId],
            set: row,
          });
      }
      signal?.throwIfAborted();
    });
  }

  async listIndexedTickets(projectId: string) {
    const rows = await this.db
      .select({ snapshot: s.ticketIndex.snapshot })
      .from(s.ticketIndex)
      .where(eq(s.ticketIndex.projectId, projectId));
    return rows.flatMap((row) => (row.snapshot ? [row.snapshot] : []));
  }

  async getIndexedTicket(projectId: string, ticketId: string) {
    const [row] = await this.db
      .select({ snapshot: s.ticketIndex.snapshot })
      .from(s.ticketIndex)
      .where(and(eq(s.ticketIndex.projectId, projectId), eq(s.ticketIndex.ticketId, ticketId)));
    return row?.snapshot ?? null;
  }

  async getWorkflow(projectId: string, ticketId: string) {
    const [row] = await this.db
      .select()
      .from(s.workflows)
      .where(and(eq(s.workflows.projectId, projectId), eq(s.workflows.ticketId, ticketId)));
    return row ? toWorkflow(row) : null;
  }

  async createWorkflow(state: WorkflowState) {
    const rows = await this.db
      .insert(s.workflows)
      .values({
        projectId: state.projectId,
        ticketId: state.ticketId,
        phase: state.phase,
        status: state.status,
        attempt: state.attempt,
        loops: state.loops,
        priority: state.priority,
        version: 0,
      })
      .onConflictDoNothing()
      .returning({ id: s.workflows.ticketId });
    return rows.length === 1;
  }

  async saveWorkflow(state: WorkflowState) {
    const rows = await this.db
      .update(s.workflows)
      .set({
        phase: state.phase,
        status: state.status,
        attempt: state.attempt,
        loops: state.loops,
        priority: state.priority,
        implementerModel: state.implementerModel ?? null,
        workspaceRef: state.workspaceRef ?? null,
        workdir: state.workdir ?? null,
        lastError: state.lastError ?? null,
        nextAttemptAt: state.nextAttemptAt ?? null,
        currentRunId: state.currentRunId ?? null,
        leaseOwner: state.leaseOwner ?? null,
        leaseExpiresAt: state.leaseExpiresAt ?? null,
        reviewedTree: state.reviewedTree ?? null,
        generation: state.generation ?? 0,
        requeuedAt: state.requeuedAt ?? null,
        requeueCount: state.requeueCount ?? 0,
        stoppedBy: state.stoppedBy ?? null,
        version: state.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(s.workflows.projectId, state.projectId),
          eq(s.workflows.ticketId, state.ticketId),
          eq(s.workflows.version, state.version),
        ),
      )
      .returning();
    const [row] = rows;
    if (!row) throw new VersionConflictError(state.projectId, state.ticketId);
    return toWorkflow(row);
  }

  async listWorkflows(filter?: { status?: WorkflowState["status"][] }) {
    const q = this.db.select().from(s.workflows);
    const rows = filter?.status?.length
      ? await q.where(inArray(s.workflows.status, filter.status))
      : await q;
    return rows.map(toWorkflow);
  }

  async createRun(run: RunRecord) {
    await this.db.insert(s.runs).values({
      id: run.id,
      projectId: run.projectId,
      ticketId: run.ticketId,
      phase: run.phase,
      attempt: run.attempt,
      stepKey: run.stepKey,
      runner: run.runner ?? null,
      model: run.model ?? null,
      host: run.host,
      ownerId: run.ownerId,
      headSha: run.headSha ?? null,
      status: run.status,
      startedAt: run.startedAt,
      lastEventAt: run.lastEventAt,
      heartbeatAt: run.heartbeatAt,
    });
  }

  async updateRun(id: string, patch: Partial<RunRecord>) {
    const { id: _id, ...rest } = patch;
    if (Object.keys(rest).length === 0) return;
    await this.db.update(s.runs).set(rest).where(eq(s.runs.id, id));
  }

  async getRun(id: string) {
    const [row] = await this.db.select().from(s.runs).where(eq(s.runs.id, id));
    return row ? toRun(row) : null;
  }

  async listRuns(filter?: { status?: RunRecordStatus[]; projectId?: string; ticketId?: string }) {
    const conds = [
      filter?.status?.length ? inArray(s.runs.status, filter.status) : undefined,
      filter?.projectId ? eq(s.runs.projectId, filter.projectId) : undefined,
      filter?.ticketId ? eq(s.runs.ticketId, filter.ticketId) : undefined,
    ].filter((c) => c !== undefined);
    const rows = await this.db
      .select()
      .from(s.runs)
      .where(and(...conds))
      .orderBy(asc(s.runs.startedAt), asc(s.runs.id));
    return rows.map(toRun);
  }

  async appendEvent(event: RunEvent) {
    await this.db.insert(s.events).values({
      runId: event.runId,
      at: new Date(event.at),
      kind: event.kind,
      message: event.message,
      data: event.data ?? null,
    });
  }

  async listEvents(runId: string) {
    const rows = await this.db
      .select()
      .from(s.events)
      .where(eq(s.events.runId, runId))
      .orderBy(asc(s.events.id));
    return rows.map((r) => ({
      runId: r.runId,
      at: r.at.toISOString(),
      kind: r.kind as RunEvent["kind"],
      message: r.message,
      ...opt("data", r.data),
    }));
  }

  async addReceipts(runId: string, receipts: Receipt[]) {
    if (receipts.length === 0) return;
    await this.db.insert(s.receipts).values(
      receipts.map((r) => ({
        runId,
        kind: r.kind,
        ok: r.ok,
        summary: r.summary,
        path: r.path ?? null,
        url: r.url ?? null,
        sha256: r.sha256 ?? null,
        data: r.data ?? null,
      })),
    );
  }

  async listReceipts(runId: string) {
    const rows = await this.db
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.runId, runId))
      .orderBy(asc(s.receipts.id));
    return rows.map((r) => ({
      kind: r.kind as Receipt["kind"],
      ok: r.ok,
      summary: r.summary,
      ...opt("path", r.path),
      ...opt("url", r.url),
      ...opt("sha256", r.sha256),
      ...opt("data", r.data),
    }));
  }

  async getStep(key: string) {
    const [r] = await this.db.select().from(s.steps).where(eq(s.steps.key, key));
    if (!r) return null;
    const step: StepRecord = {
      key: r.key,
      runId: r.runId,
      phase: r.phase as Phase,
      input: r.input,
      ...opt("output", r.output),
      ...opt("ok", r.ok),
      ...opt("model", r.model),
      ...opt("inputTokens", r.inputTokens),
      ...opt("outputTokens", r.outputTokens),
      ...opt("costUsd", r.costUsd),
      ...opt("completedAt", r.completedAt),
    };
    return step;
  }

  async startStep(step: StepRecord) {
    await this.db
      .insert(s.steps)
      .values({ key: step.key, runId: step.runId, phase: step.phase, input: step.input ?? {} })
      .onConflictDoUpdate({
        target: s.steps.key,
        set: { runId: step.runId },
        where: sql`${s.steps.completedAt} is null`,
      });
  }

  async completeStep(key: string, patch: Partial<StepRecord>) {
    const { key: _k, ...rest } = patch;
    await this.db.update(s.steps).set(rest).where(eq(s.steps.key, key));
  }

  async createApproval(a: ApprovalRecord) {
    await this.db.insert(s.approvals).values({
      id: a.id,
      projectId: a.projectId,
      ticketId: a.ticketId,
      phase: a.phase,
      runId: a.runId,
      headSha: a.headSha,
      requestedBy: a.requestedBy,
      status: a.status,
      requestedAt: a.requestedAt,
    });
  }

  async getApproval(id: string) {
    const [row] = await this.db.select().from(s.approvals).where(eq(s.approvals.id, id));
    return row ? toApproval(row) : null;
  }

  async listApprovals(projectId: string, ticketId: string, phase: Phase) {
    const rows = await this.db
      .select()
      .from(s.approvals)
      .where(
        and(
          eq(s.approvals.projectId, projectId),
          eq(s.approvals.ticketId, ticketId),
          eq(s.approvals.phase, phase),
        ),
      )
      .orderBy(asc(s.approvals.requestedAt), asc(s.approvals.id));
    return rows.map(toApproval);
  }

  async getPendingApproval(projectId: string, ticketId: string, phase: Phase) {
    const [row] = await this.db
      .select()
      .from(s.approvals)
      .where(
        and(
          eq(s.approvals.projectId, projectId),
          eq(s.approvals.ticketId, ticketId),
          eq(s.approvals.phase, phase),
          eq(s.approvals.status, "pending"),
        ),
      );
    return row ? toApproval(row) : null;
  }

  async decideApproval(id: string, status: "approved" | "rejected", by: Approver, note?: string) {
    const [row] = await this.db
      .update(s.approvals)
      .set({
        status,
        decidedAt: new Date(),
        decidedBy: by.id,
        decidedByKind: by.kind,
        note: note ?? null,
      })
      .where(and(eq(s.approvals.id, id), eq(s.approvals.status, "pending")))
      .returning();
    if (!row) throw new Error(`approval ${id} not found or already decided`);
    return toApproval(row);
  }

  async setAutonomy(change: AutonomyChange) {
    await this.db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(s.projects)
        .where(eq(s.projects.id, change.projectId))
        .for("update");
      if (!project) throw new Error(`project ${change.projectId} not found`);
      await tx
        .insert(s.autonomySettings)
        .values({
          projectId: change.projectId,
          phase: change.phase,
          mode: change.mode,
          updatedAt: change.at,
        })
        .onConflictDoUpdate({
          target: [s.autonomySettings.projectId, s.autonomySettings.phase],
          set: { mode: change.mode, updatedAt: change.at },
        });
      await tx.insert(s.autonomyHistory).values({
        projectId: change.projectId,
        phase: change.phase,
        mode: change.mode,
        actor: change.actor,
        reason: change.reason ?? null,
        at: change.at,
      });
    });
  }

  async setAutonomyPolicy(
    projectId: string,
    policy: Partial<Record<Phase, AutonomyMode>>,
    actor: string,
    expected?: Record<Phase, AutonomyMode> | string,
  ) {
    await this.db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(s.projects)
        .where(eq(s.projects.id, projectId))
        .for("update");
      if (!project) throw new Error(`project ${projectId} not found`);
      const snapshot = await this.readProjectPolicy(tx, project.config as ProjectConfig);
      const config = snapshot.project;
      const current = config.autonomy;
      if (typeof expected === "string" && snapshot.version !== expected)
        throw new AutonomyConflictError();
      if (
        expected &&
        typeof expected !== "string" &&
        PHASES.some((phase) => expected[phase] !== (current[phase] ?? current.default))
      )
        throw new AutonomyConflictError();
      const at = new Date();
      await tx
        .update(s.projects)
        .set({ config: { ...config, autonomy: { ...config.autonomy, ...policy } }, updatedAt: at })
        .where(eq(s.projects.id, projectId));
      for (const [phase, mode] of Object.entries(policy) as [Phase, AutonomyChange["mode"]][]) {
        await tx
          .insert(s.autonomySettings)
          .values({ projectId, phase, mode, updatedAt: at })
          .onConflictDoUpdate({
            target: [s.autonomySettings.projectId, s.autonomySettings.phase],
            set: { mode, updatedAt: at },
          });
        await tx.insert(s.autonomyHistory).values({ projectId, phase, mode, actor, at });
      }
    });
  }

  async autonomyHistory(projectId: string) {
    const rows = await this.db
      .select()
      .from(s.autonomyHistory)
      .where(eq(s.autonomyHistory.projectId, projectId))
      .orderBy(asc(s.autonomyHistory.id));
    return rows.map((r) => ({
      projectId: r.projectId,
      phase: r.phase as AutonomyChange["phase"],
      mode: r.mode as AutonomyChange["mode"],
      actor: r.actor,
      at: r.at,
      ...opt("reason", r.reason),
    }));
  }

  private async readProjectPolicy(db: Pick<Db, "select">, config: ProjectConfig) {
    const overrides = await db
      .select()
      .from(s.autonomySettings)
      .where(eq(s.autonomySettings.projectId, config.id));
    const autonomy = { ...config.autonomy };
    for (const row of overrides) {
      if (row.phase === "default") autonomy.default = row.mode as AutonomyMode;
      else autonomy[row.phase as Phase] = row.mode as AutonomyMode;
    }
    const rows = await db
      .select()
      .from(s.autonomyHistory)
      .where(eq(s.autonomyHistory.projectId, config.id))
      .orderBy(asc(s.autonomyHistory.id));
    const history: AutonomyChange[] = rows.map((row) => ({
      projectId: row.projectId,
      phase: row.phase as AutonomyChange["phase"],
      mode: row.mode as AutonomyMode,
      actor: row.actor,
      at: row.at,
      ...opt("reason", row.reason),
    }));
    return projectPolicySnapshot({ ...config, autonomy }, history);
  }

  async getProjectPolicy(projectId: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(s.projects)
        .where(eq(s.projects.id, projectId))
        .for("update");
      if (!row) throw new Error(`project ${projectId} not found`);
      return this.readProjectPolicy(tx, row.config as ProjectConfig);
    });
  }

  async saveInitializedProject(
    config: ProjectConfig,
    policy: Partial<Record<Phase, AutonomyMode>>,
    expectedVersion: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(s.projects)
        .where(eq(s.projects.id, config.id))
        .for("update");
      if (!row) throw new Error(`project ${config.id} not found`);
      const snapshot = await this.readProjectPolicy(tx, row.config as ProjectConfig);
      if (snapshot.version !== expectedVersion) throw new AutonomyConflictError();
      const current = snapshot.project;
      const updated = {
        ...current,
        reviewLanes: config.reviewLanes,
        dailyBudgetUsd: config.dailyBudgetUsd,
        perTicketBudgetUsd: config.perTicketBudgetUsd,
        autonomy: { ...current.autonomy, ...policy },
      } as ProjectConfig;
      const at = new Date();
      await tx
        .update(s.projects)
        .set({ config: updated, updatedAt: at })
        .where(eq(s.projects.id, config.id));
      for (const [phase, mode] of Object.entries(policy) as [Phase, AutonomyMode][]) {
        await tx
          .insert(s.autonomySettings)
          .values({ projectId: config.id, phase, mode, updatedAt: at })
          .onConflictDoUpdate({
            target: [s.autonomySettings.projectId, s.autonomySettings.phase],
            set: { mode, updatedAt: at },
          });
        if (mode !== (current.autonomy[phase] ?? current.autonomy.default))
          await tx
            .insert(s.autonomyHistory)
            .values({ projectId: config.id, phase, mode, actor: "init", at });
      }
      return this.readProjectPolicy(tx, updated);
    });
  }

  async addSpend(projectId: string, day: string, usd: number) {
    const [row] = await this.db
      .insert(s.budgets)
      .values({ projectId, day, spentUsd: usd })
      .onConflictDoUpdate({
        target: [s.budgets.projectId, s.budgets.day],
        set: { spentUsd: sql`${s.budgets.spentUsd} + ${usd}` },
      })
      .returning({ spent: s.budgets.spentUsd });
    return row?.spent ?? usd;
  }

  async getSpend(projectId: string, day: string) {
    const [row] = await this.db
      .select()
      .from(s.budgets)
      .where(and(eq(s.budgets.projectId, projectId), eq(s.budgets.day, day)));
    return row?.spentUsd ?? 0;
  }

  async addLesson(lesson: Lesson) {
    await this.db.insert(s.lessons).values(lesson);
  }

  async listLessons(projectId: string) {
    const rows = await this.db
      .select()
      .from(s.lessons)
      .where(eq(s.lessons.projectId, projectId))
      .orderBy(asc(s.lessons.id));
    return rows.map((r) => ({
      projectId: r.projectId,
      ticketId: r.ticketId,
      source: r.source,
      lesson: r.lesson,
    }));
  }

  async saveLabelRetry(retry: LabelRetry) {
    const row = { projectId: retry.projectId, ticketId: retry.ticketId, id: retry.id, fix: retry };
    await this.db
      .insert(s.labelRetries)
      .values(row)
      .onConflictDoUpdate({
        target: [s.labelRetries.projectId, s.labelRetries.ticketId],
        set: { id: retry.id, fix: retry, updatedAt: new Date() },
      });
  }

  async updateLabelRetry(retry: LabelRetry) {
    await this.db
      .update(s.labelRetries)
      .set({ fix: retry, updatedAt: new Date() })
      .where(
        and(
          eq(s.labelRetries.projectId, retry.projectId),
          eq(s.labelRetries.ticketId, retry.ticketId),
          eq(s.labelRetries.id, retry.id),
        ),
      );
  }

  async deleteLabelRetry(projectId: string, ticketId: string, id: string) {
    await this.db
      .delete(s.labelRetries)
      .where(
        and(
          eq(s.labelRetries.projectId, projectId),
          eq(s.labelRetries.ticketId, ticketId),
          eq(s.labelRetries.id, id),
        ),
      );
  }

  async listLabelRetries() {
    const rows = await this.db.select().from(s.labelRetries).orderBy(asc(s.labelRetries.updatedAt));
    return rows.map((r) => ({ ...(r.fix as LabelRetry), id: r.id }));
  }
}
