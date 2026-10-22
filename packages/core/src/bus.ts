import type { Phase, Receipt, RunEvent } from "./ports.js";
import type { RunRecordStatus } from "./store.js";
import type { WorkflowState } from "./types.js";

export type BusEvent =
  | {
      type: "run.started";
      runId: string;
      projectId: string;
      ticketId: string;
      phase: Phase;
      model?: string;
    }
  | { type: "run.event"; event: RunEvent }
  | {
      type: "run.finished";
      runId: string;
      status: RunRecordStatus;
      summary: string;
      receipts: Receipt[];
    }
  | { type: "workflow.changed"; workflow: WorkflowState }
  | {
      type: "approval.requested";
      approvalId: string;
      projectId: string;
      ticketId: string;
      phase: Phase;
    }
  | { type: "approval.decided"; approvalId: string; status: "approved" | "rejected" }
  | { type: "workflow.blocked"; projectId: string; ticketId: string; reason: string }
  | { type: "autonomy.changed"; projectId: string; phase: Phase | "default"; mode: string }
  | TrackerFailedEvent
  | QuotaCooldownEvent;

/** A provider hit a rate/usage limit: no new runs on it until `until`; tickets stay queued. */
export interface QuotaCooldownEvent {
  type: "quota.cooldown";
  provider: string;
  until: string;
  failures: number;
  reason: string;
  at: string;
  projectId: string;
  ticketId: string;
}

/** A best-effort write to the project's ticket tracker failed; the workflow carries on. */
export interface TrackerFailedEvent {
  type: "tracker.failed";
  projectId: string;
  ticketId?: string;
  /** What Matrix tried: `update`, `comment`, `setPhase`, `upsertComment`, `ensureScope`. */
  operation: string;
  message: string;
  at: string;
}

export type BusListener = (event: BusEvent) => void;

export class EventBus {
  private listeners = new Set<BusListener>();

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: BusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must never break the orchestrator.
      }
    }
  }
}
