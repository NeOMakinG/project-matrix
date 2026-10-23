import {
  type BusEvent,
  checksStatusLine,
  type EventBus,
  newFailureNames,
  type WorkflowState,
} from "@matrix/core";
import type { TicketStore } from "@matrix/tickets";
import {
  type OrcaStatusRef,
  orcaRef,
  renderStatus,
  type StatusLink,
  safeLink,
  withTimestamp,
} from "./tracker-status.js";

export interface TrackerSyncOptions {
  bus: EventBus;
  tickets: (projectId: string) => Promise<TicketStore>;
  /** Quiet period before a burst of workflow changes is written to the tracker. */
  debounceMs?: number;
  clock?: () => Date;
  /** Cap on tracked tickets; the oldest idle entries are dropped beyond it. */
  maxEntries?: number;
}

interface Entry {
  projectId: string;
  ticketId: string;
  latest?: WorkflowState;
  links: StatusLink[];
  orca?: OrcaStatusRef | undefined;
  pullRequest?: StatusLink | undefined;
  /** Latest checks summary vs the base commit ("0 new failures (273 pre-existing ...)"). */
  checks?: string | undefined;
  /** First new failure names of the latest checks run (sanitized, at most 20). */
  newFailures?: string[] | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
  running?: Promise<void> | undefined;
  dirty: boolean;
  sentPosition?: string;
  sentBody?: string;
  /** Set by a failed write in the current attempt; drives the capped retry. */
  failed: boolean;
  retries: number;
}

export const STATUS_COMMENT_KEY = "matrix-status";
const MAX_LINKS = 5;
const MAX_RETRIES = 3;

/**
 * Mirrors workflow progress into trackers that support it: moves the ticket to its phase column
 * (`setPhase`) and keeps one live status comment (`upsertComment`). Bursts are coalesced per
 * ticket; writes are serialized per ticket; failures become `tracker.failed` events and never
 * reach the workflow. Trackers without these capabilities get no writes at all.
 */
export class TrackerSync {
  readonly #o: Required<Omit<TrackerSyncOptions, "clock">> & { clock: () => Date };
  readonly #entries = new Map<string, Entry>();
  readonly #runs = new Map<string, string>();
  #unsubscribe: (() => void) | undefined;

  constructor(options: TrackerSyncOptions) {
    this.#o = {
      debounceMs: 1_500,
      maxEntries: 2_000,
      clock: () => new Date(),
      ...options,
    };
  }

  start(): void {
    this.#unsubscribe ??= this.#o.bus.subscribe((event) => this.#on(event));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const entry of this.#entries.values()) clearTimeout(entry.timer);
  }

  /** Writes everything pending now (tests, shutdown). */
  async flush(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      const busy = [...this.#entries.values()].filter((e) => e.timer || e.running || e.dirty);
      if (busy.length === 0) return;
      await Promise.all(
        busy.map(async (e) => {
          if (e.timer) {
            clearTimeout(e.timer);
            e.timer = undefined;
            e.dirty = true;
          }
          await e.running;
          if (e.dirty && !e.running) this.#run(e);
          await e.running;
        }),
      );
    }
  }

  #entry(projectId: string, ticketId: string): Entry {
    const key = `${projectId}\u0000${ticketId}`;
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { projectId, ticketId, links: [], dirty: false, failed: false, retries: 0 };
      this.#entries.set(key, entry);
      this.#evict();
    }
    return entry;
  }

  #evict(): void {
    for (const [key, entry] of this.#entries) {
      if (this.#entries.size <= this.#o.maxEntries) return;
      if (entry.timer || entry.running) continue;
      this.#entries.delete(key);
    }
  }

  #on(event: BusEvent): void {
    if (event.type === "workflow.changed") {
      const w = event.workflow;
      const entry = this.#entry(w.projectId, w.ticketId);
      entry.latest = w;
      entry.retries = 0;
      this.#schedule(entry);
    } else if (event.type === "pull_request.opened") {
      const entry = this.#entry(event.projectId, event.ticketId);
      const link = safeLink(event.branch, event.url);
      if (!link || entry.pullRequest?.url === link.url) return;
      entry.pullRequest = link;
      this.#schedule(entry);
    } else if (event.type === "run.started") {
      this.#runs.set(event.runId, `${event.projectId}\u0000${event.ticketId}`);
      if (this.#runs.size > 1_000) this.#runs.delete(this.#runs.keys().next().value as string);
    } else if (event.type === "run.finished") {
      const key = this.#runs.get(event.runId);
      this.#runs.delete(event.runId);
      const entry = key ? this.#entries.get(key) : undefined;
      if (!entry) return;
      let changed = false;
      const checks = checksStatusLine(event.receipts);
      if (checks && checks !== entry.checks) {
        entry.checks = checks;
        changed = true;
      }
      if (checks) {
        const names = newFailureNames(event.receipts, 20);
        if (names.join("\n") !== (entry.newFailures ?? []).join("\n")) {
          entry.newFailures = names;
          changed = true;
        }
      }
      for (const r of event.receipts) {
        const orca = orcaRef(r.data);
        if (orca && (orca.run !== entry.orca?.run || orca.dispatch !== entry.orca?.dispatch)) {
          entry.orca = orca;
          changed = true;
        }
        const link = safeLink(`${r.kind}${r.ok ? "" : " (failed)"}`, r.url);
        if (!link || entry.links.some((l) => l.url === link.url)) continue;
        entry.links = [...entry.links, link].slice(-MAX_LINKS);
        changed = true;
      }
      if (changed) this.#schedule(entry);
    }
  }

  #schedule(entry: Entry): void {
    if (entry.running) {
      entry.dirty = true;
      return;
    }
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.#run(entry);
    }, this.#o.debounceMs);
    entry.timer.unref?.();
  }

  #run(entry: Entry): void {
    entry.dirty = false;
    entry.failed = false;
    entry.running = this.#write(entry).finally(() => {
      entry.running = undefined;
      if (entry.dirty) return this.#schedule(entry);
      if (entry.failed && entry.retries < MAX_RETRIES) {
        // Retry the latest state with backoff instead of waiting for the next workflow change.
        entry.retries += 1;
        const delay = Math.min(this.#o.debounceMs * 2 ** entry.retries, 5 * 60_000);
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          this.#run(entry);
        }, delay);
        entry.timer.unref?.();
        return;
      }
      if (!entry.failed) entry.retries = 0;
      if (!entry.failed && entry.latest?.status === "done") this.#forget(entry);
    });
  }

  #forget(entry: Entry): void {
    if (entry.timer || entry.running) return;
    this.#entries.delete(`${entry.projectId}\u0000${entry.ticketId}`);
  }

  async #write(entry: Entry): Promise<void> {
    const w = entry.latest;
    if (!w) return;
    let store: TicketStore;
    try {
      store = await this.#o.tickets(w.projectId);
    } catch (error) {
      return this.#failed(entry, "resolve", error);
    }
    const position = `${w.phase}\u0000${w.status}`;
    if (store.setPhase && entry.sentPosition !== position) {
      try {
        await store.setPhase(w.ticketId, { phase: w.phase, status: w.status });
        entry.sentPosition = position;
      } catch (error) {
        this.#failed(entry, "setPhase", error);
      }
    }
    const body = renderStatus(
      w,
      entry.links,
      entry.orca,
      entry.pullRequest,
      entry.checks,
      entry.newFailures,
    );
    if (store.upsertComment && entry.sentBody !== body) {
      try {
        await store.upsertComment(
          w.ticketId,
          STATUS_COMMENT_KEY,
          withTimestamp(body, this.#o.clock()),
        );
        entry.sentBody = body;
      } catch (error) {
        this.#failed(entry, "upsertComment", error);
      }
    }
  }

  #failed(entry: Entry, operation: string, error: unknown): void {
    entry.failed = true;
    this.#o.bus.publish({
      type: "tracker.failed",
      projectId: entry.projectId,
      ticketId: entry.ticketId,
      operation,
      message: error instanceof Error ? error.message : String(error),
      at: this.#o.clock().toISOString(),
    });
  }
}
