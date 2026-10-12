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
  | { type: "autonomy.changed"; projectId: string; phase: Phase | "default"; mode: string };

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
