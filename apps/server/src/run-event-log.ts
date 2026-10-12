import type { RunEvent } from "@matrix/core";
import type { CorePort } from "./core-port.js";

export interface LoggedEvent {
  id: number;
  event: RunEvent;
}

interface Tracked {
  seq: number;
  events: LoggedEvent[];
  listeners: Set<(entry: LoggedEvent) => void>;
  unsubscribe: () => void;
}

/**
 * Numbers run events and keeps a bounded backlog per run so SSE clients can resume with
 * `Last-Event-ID`. A run is tracked from the first stream opened on it; events older than the
 * backlog (or emitted before tracking started) aren't replayed.
 */
export class RunEventLog {
  private readonly runs = new Map<string, Tracked>();

  constructor(
    private readonly core: CorePort,
    private readonly maxPerRun = 500,
    private readonly maxRuns = 1000,
  ) {}

  private track(runId: string): Tracked {
    const existing = this.runs.get(runId);
    if (existing) {
      // refresh LRU position
      this.runs.delete(runId);
      this.runs.set(runId, existing);
      return existing;
    }
    const tracked: Tracked = { seq: 0, events: [], listeners: new Set(), unsubscribe: () => {} };
    tracked.unsubscribe = this.core.subscribe(runId, (event) => {
      tracked.seq += 1;
      const entry = { id: tracked.seq, event };
      tracked.events.push(entry);
      if (tracked.events.length > this.maxPerRun) tracked.events.shift();
      for (const listener of tracked.listeners) listener(entry);
    });
    this.runs.set(runId, tracked);
    while (this.runs.size > this.maxRuns) {
      const [oldestId, oldest] = this.runs.entries().next().value as [string, Tracked];
      if (oldest.listeners.size > 0) break;
      oldest.unsubscribe();
      this.runs.delete(oldestId);
    }
    return tracked;
  }

  /** Events after `lastId` still in the backlog, then live events through `listener`. */
  open(runId: string, lastId: number | undefined, listener: (entry: LoggedEvent) => void) {
    const tracked = this.track(runId);
    const backlog = lastId === undefined ? [] : tracked.events.filter((e) => e.id > lastId);
    const missed = lastId !== undefined && (tracked.events[0]?.id ?? tracked.seq + 1) > lastId + 1;
    tracked.listeners.add(listener);
    return {
      backlog,
      /** True when some events after `lastId` were dropped from the backlog. */
      missed,
      close: () => tracked.listeners.delete(listener),
    };
  }
}
