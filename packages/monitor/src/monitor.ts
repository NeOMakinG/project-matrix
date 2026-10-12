import type { TicketStore } from "@matrix/tickets";
import { type Issue, type IssueStore, ingest } from "./group.js";
import { normalize } from "./normalize/index.js";
import { applyPolicy, type Decision, defaultPolicy, type PolicyOptions } from "./policy.js";
import type { GraphPort, LlmClient, Notifier, ReleasePort } from "./ports.js";
import type { SignalSource } from "./signal.js";
import { type Triage, triage } from "./triage.js";
import { defaultVerify, type VerifyOptions, type VerifyResult, verifyFix } from "./verify.js";

export interface MonitorDeps {
  source: SignalSource;
  store: IssueStore;
  tickets: TicketStore;
  llm: LlmClient;
  graph: GraphPort;
  releases: ReleasePort;
  notifier?: Notifier;
  model: string;
  defaultProjectId: string;
  policy?: PolicyOptions;
  verify?: VerifyOptions;
  clock?: () => string;
}

export interface TickResult {
  signals: number;
  newIssues: number;
  triaged: { issue: Issue; triage: Triage; decision: Decision }[];
}

export interface VerifyRecord {
  fingerprint: string;
  result: VerifyResult;
}

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
    const raw = await this.deps.source.pull(this.cursor);
    const signals = raw.flatMap((r) => normalize(r, this.deps.defaultProjectId));
    for (const r of raw) {
      if (Date.parse(r.receivedAt) > Date.parse(this.cursor)) this.cursor = r.receivedAt;
    }
    const results = await ingest(this.deps.store, signals);

    // Triage each issue once per tick: new issues, recurrences, and issues still untriaged.
    const toTriage = new Map<string, Issue>();
    for (const r of results) {
      if (r.isNew || r.recurred || r.issue.status === "new")
        toTriage.set(r.issue.fingerprint, r.issue);
    }

    const triaged: TickResult["triaged"] = [];
    for (const issue of toTriage.values()) {
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
      };
      if (this.deps.notifier) policyDeps.notifier = this.deps.notifier;
      const decision = await applyPolicy(issue, t, policyDeps);

      const fresh = (await this.deps.store.get(issue.fingerprint)) ?? issue;
      if (decision.action === "auto-fix" || decision.action === "human") {
        fresh.ticketId = decision.ticketId;
        fresh.status = decision.action === "auto-fix" ? "ticketed" : "human";
      } else if (decision.action === "ignored") {
        fresh.status = "triaged";
      } else if (fresh.status === "reopened") {
        fresh.status = "ticketed";
      }
      await this.deps.store.save(fresh);
      triaged.push({ issue: fresh, triage: t, decision });
    }

    return {
      signals: signals.length,
      newIssues: results.filter((r) => r.isNew).length,
      triaged,
    };
  }

  /** Called by the loop's deploy phase when a release containing the fix is live. */
  async markFixDeployed(fingerprint: string, release: string): Promise<void> {
    const issue = await this.deps.store.get(fingerprint);
    if (!issue) throw new Error(`unknown issue ${fingerprint}`);
    issue.fixRelease = release;
    issue.status = "verifying";
    await this.deps.store.save(issue);
  }

  /** Verify step: closes tickets whose fix held, reopens the ones that didn't. */
  async verify(): Promise<VerifyRecord[]> {
    const now = this.now();
    const records: VerifyRecord[] = [];
    for (const issue of await this.deps.store.list()) {
      if (issue.status !== "verifying" || !issue.fixRelease) continue;
      const deployments = await this.deps.releases.deployments(issue.projectId);
      const deploy = deployments.find((d) => d.release === issue.fixRelease);
      if (!deploy) continue;
      const result = await verifyFix(
        issue,
        deploy.deployedAt,
        this.deps.store,
        now,
        this.deps.verify ?? defaultVerify,
      );
      records.push({ fingerprint: issue.fingerprint, result });
      if (result.outcome === "pending") continue;

      issue.status = result.outcome === "resolved" ? "resolved" : "reopened";
      await this.deps.store.save(issue);
      if (issue.ticketId) {
        await this.deps.tickets.comment(
          issue.ticketId,
          `Verify after ${issue.fixRelease}: ${result.outcome}. ${result.reason}.`,
        );
        await this.deps.tickets.update(issue.ticketId, {
          status: result.outcome === "resolved" ? "done" : "open",
        });
      }
      if (result.outcome === "reopened" && this.deps.notifier) {
        await this.deps.notifier.notify({
          projectId: issue.projectId,
          severity: "high",
          title: `Fix did not hold: ${issue.title}`,
          body: result.reason,
        });
      }
    }
    return records;
  }
}
