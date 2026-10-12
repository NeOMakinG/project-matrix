import type { TicketStore } from "@matrix/tickets";
import { type Issue, type IssueStore, ingest } from "./group.js";
import { type NormalizeOptions, normalize } from "./normalize/index.js";
import {
  applyPolicy,
  type Decision,
  defaultPolicy,
  type PolicyOptions,
  type TrackerVisibility,
} from "./policy.js";
import type { GraphPort, LlmClient, Notifier, ReleasePort } from "./ports.js";
import type { SignalSource } from "./signal.js";
import { type Triage, triage } from "./triage.js";
import { defaultVerify, type VerifyOptions, type VerifyResult, verifyFix } from "./verify.js";

export interface MonitorDeps {
  source: SignalSource;
  store: IssueStore;
  tickets: TicketStore;
  /** Whether the ticket tracker is private; prod-fix tickets are refused otherwise (see policy). */
  trackerVisibility: TrackerVisibility;
  llm: LlmClient;
  graph: GraphPort;
  releases: ReleasePort;
  notifier?: Notifier;
  model: string;
  defaultProjectId: string;
  normalize?: NormalizeOptions;
  policy?: PolicyOptions;
  verify?: VerifyOptions;
  /** Re-read this much before the cursor each tick; dedupe makes the overlap free. */
  overlapMs?: number;
  clock?: () => string;
}

export interface TickResult {
  signals: number;
  newIssues: number;
  triaged: { issue: Issue; triage: Triage; decision: Decision }[];
  /** Failures are reported, never swallowed; the affected work is retried next tick. */
  errors: string[];
}

export interface VerifyRecord {
  fingerprint: string;
  result: VerifyResult;
}

const PENDING = new Set<Issue["status"]>(["new", "reopened"]);
const errText = (e: unknown) =>
  (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);

/** The prod loop: signals → issues → triage → tickets, and fix verification after deploys. */
export class Monitor {
  private cursor: string;
  private readonly now: () => string;

  constructor(
    private readonly deps: MonitorDeps,
    since = new Date(0).toISOString(),
  ) {
    this.cursor = since;
    this.now = deps.clock ?? (() => new Date().toISOString());
  }

  get since() {
    return this.cursor;
  }

  async tick(): Promise<TickResult> {
    const now = this.now();
    const errors: string[] = [];
    const overlap = this.deps.overlapMs ?? 10 * 60_000;

    let signals: ReturnType<typeof normalize> = [];
    let results: Awaited<ReturnType<typeof ingest>> = [];
    try {
      const since = new Date(Math.max(0, Date.parse(this.cursor) - overlap)).toISOString();
      const raw = await this.deps.source.pull(since);
      errors.push(...(this.deps.source.drainErrors?.() ?? []));
      signals = raw.flatMap((r) => normalize(r, this.deps.defaultProjectId, this.deps.normalize));
      results = await ingest(this.deps.store, signals);
      // Checkpoint only after everything pulled is stored.
      for (const r of raw) {
        if (Date.parse(r.receivedAt) > Date.parse(this.cursor)) this.cursor = r.receivedAt;
      }
    } catch (e) {
      errors.push(`ingest: ${errText(e)}`);
    }

    // Everything still pending is retried, not only issues touched by this tick's signals.
    const pending = (await this.deps.store.list()).filter((i) => PENDING.has(i.status));
    const triaged: TickResult["triaged"] = [];
    for (const issue of pending) {
      try {
        triaged.push(await this.process(issue, now));
      } catch (e) {
        errors.push(`triage ${issue.fingerprint}: ${errText(e)}`);
        const latest = (await this.deps.store.get(issue.fingerprint)) ?? issue;
        latest.lastError = errText(e);
        await this.deps.store.save(latest);
      }
    }

    return {
      signals: signals.length,
      newIssues: results.filter((r) => r.isNew).length,
      triaged,
      errors,
    };
  }

  private async process(issue: Issue, now: string) {
    const deployments = await this.deps.releases.deployments(issue.projectId);
    const t = await triage(issue, {
      llm: this.deps.llm,
      graph: this.deps.graph,
      model: this.deps.model,
      deployments,
      now,
    });
    const policyDeps: Parameters<typeof applyPolicy>[2] = {
      tickets: this.deps.tickets,
      options: this.deps.policy ?? defaultPolicy,
      trackerVisibility: this.deps.trackerVisibility,
    };
    if (this.deps.notifier) policyDeps.notifier = this.deps.notifier;
    const decision = await applyPolicy(issue, t, policyDeps);

    const latest = (await this.deps.store.get(issue.fingerprint)) ?? issue;
    delete latest.lastError;
    switch (decision.action) {
      case "auto-fix":
        latest.ticketId = decision.ticketId;
        latest.status = "ticketed";
        break;
      case "human":
        latest.ticketId = decision.ticketId;
        latest.status = "human";
        break;
      case "updated":
        latest.ticketId = decision.ticketId;
        // "new" here means a ticket created before a crash was found again; a recurrence goes to a human.
        latest.status = latest.status === "new" ? "ticketed" : "human";
        break;
      case "blocked":
        latest.status = "triaged";
        latest.lastError = decision.reason;
        break;
      case "ignored":
        latest.status = "triaged";
        break;
    }
    await this.deps.store.save(latest);
    return { issue: latest, triage: t, decision };
  }

  /** Called by the loop's deploy phase when a release containing the fix is live. */
  async markFixDeployed(fingerprint: string, release: string): Promise<void> {
    const issue = await this.deps.store.get(fingerprint);
    if (!issue) throw new Error(`unknown issue ${fingerprint}`);
    issue.fixRelease = release;
    issue.status = "verifying";
    await this.deps.store.save(issue);
  }

  /**
   * Verify step: closes tickets whose fix held, reopens the ones that didn't. The ticket is updated
   * first and the issue saved last, so a tracker failure leaves the issue in "verifying" and the
   * whole step is retried next time.
   */
  async verify(): Promise<VerifyRecord[]> {
    const now = this.now();
    const records: VerifyRecord[] = [];
    for (const issue of await this.deps.store.list()) {
      if (issue.status !== "verifying" || !issue.fixRelease) continue;
      const deployments = [...(await this.deps.releases.deployments(issue.projectId))].sort(
        (a, b) => Date.parse(a.deployedAt) - Date.parse(b.deployedAt),
      );
      const idx = deployments.findIndex((d) => d.release === issue.fixRelease);
      const deploy = deployments[idx];
      if (!deploy) continue;
      const result = await verifyFix(
        issue,
        {
          release: deploy.release,
          deployedAt: deploy.deployedAt,
          olderReleases: deployments.slice(0, idx).map((d) => d.release),
        },
        this.deps.store,
        now,
        this.deps.verify ?? defaultVerify,
      );
      records.push({ fingerprint: issue.fingerprint, result });
      if (result.outcome === "pending") continue;

      const next: Issue["status"] =
        result.outcome === "resolved"
          ? "resolved"
          : result.outcome === "reopened"
            ? "reopened"
            : "human";
      if (issue.ticketId) {
        await this.deps.tickets.comment(
          issue.ticketId,
          `Verify after ${issue.fixRelease}: ${result.outcome}. ${result.reason}.`,
        );
        await this.deps.tickets.update(issue.ticketId, {
          status: result.outcome === "resolved" ? "done" : "open",
        });
      }
      issue.status = next;
      await this.deps.store.save(issue);
      if (result.outcome !== "resolved" && this.deps.notifier) {
        await this.deps.notifier.notify({
          projectId: issue.projectId,
          severity: result.outcome === "reopened" ? "high" : "medium",
          title:
            result.outcome === "reopened"
              ? `Fix did not hold: ${issue.fingerprint}`
              : `Fix could not be verified: ${issue.fingerprint}`,
          body: result.reason,
        });
      }
    }
    return records;
  }
}
