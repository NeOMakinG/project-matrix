import { randomUUID } from "node:crypto";
import {
  framesOnlyGraph,
  type Issue,
  type LlmClient,
  MemoryIssueStore,
  Monitor,
  type RawSignal,
  type SignalSource,
  type TickResult,
} from "@matrix/monitor";
import type { TicketStore } from "@matrix/tickets";
import type { Incident, IncidentStatus, MonitorSignal } from "../core-port.js";
import type { MonitorPort } from "./real-core.js";

/** Webhook signals as received by the server; the monitor pulls them by time. */
export class SignalBuffer {
  private readonly signals: RawSignal[] = [];

  constructor(private readonly max = 10_000) {}

  push(signal: MonitorSignal): void {
    this.signals.push(signal as RawSignal);
    if (this.signals.length > this.max) this.signals.shift();
  }

  sourceFor(projectId: string): SignalSource {
    return {
      pull: async (since) =>
        this.signals.filter((s) => s.projectId === projectId && s.receivedAt >= since),
    };
  }
}

/** Deterministic triage for the fake runtime: every signal looks fixable code. */
export const fakeTriageLlm: LlmClient = {
  complete: async () =>
    JSON.stringify({
      fixable: 0.9,
      category: "code",
      rootCause: "fake runtime triage",
      rationale: "deterministic answer for end-to-end receipts",
      suspectedFiles: [],
      reproSteps: [],
    }),
};

export interface MonitorWiring {
  llm: LlmClient;
  model: string;
  tickets: (projectId: string) => Promise<TicketStore>;
  projectIds: () => Promise<string[]>;
}

const INCIDENT_STATUS: Record<Issue["status"], IncidentStatus> = {
  new: "open",
  reopened: "open",
  triaged: "open",
  human: "open",
  ticketed: "fixing",
  verifying: "fixing",
  resolved: "resolved",
};

/**
 * The prod loop on top of @matrix/monitor: webhook signals → per-project Monitor (normalize, group,
 * triage, policy) → tickets in the project's tracker. `tick()` runs from the server's loop.
 */
export class ServerMonitor implements MonitorPort {
  readonly buffer = new SignalBuffer();
  readonly issues = new MemoryIssueStore();
  private readonly monitors = new Map<string, Monitor>();

  constructor(private readonly wiring: MonitorWiring) {}

  async ingest(signal: MonitorSignal): Promise<{ id: string }> {
    this.buffer.push(signal);
    return { id: randomUUID() };
  }

  private async monitorFor(projectId: string): Promise<Monitor> {
    const existing = this.monitors.get(projectId);
    if (existing) return existing;
    const monitor = new Monitor({
      source: this.buffer.sourceFor(projectId),
      store: this.issues,
      tickets: await this.wiring.tickets(projectId),
      // Local trackers (markdown, beads) are private to the factory host.
      trackerVisibility: "private",
      llm: this.wiring.llm,
      graph: framesOnlyGraph,
      releases: { deployments: async () => [] },
      model: this.wiring.model,
      defaultProjectId: projectId,
    });
    this.monitors.set(projectId, monitor);
    return monitor;
  }

  async tick(): Promise<Record<string, TickResult>> {
    const out: Record<string, TickResult> = {};
    for (const projectId of await this.wiring.projectIds()) {
      out[projectId] = await (await this.monitorFor(projectId)).tick();
    }
    return out;
  }

  async incidents(query: { projectId?: string; status?: IncidentStatus }): Promise<Incident[]> {
    const issues = await this.issues.list(query.projectId);
    return issues
      .map((issue) => ({
        id: issue.fingerprint,
        projectId: issue.projectId,
        source: (issue.providers[0] === "glitchtip" || issue.providers[0] === "uptime"
          ? "otel"
          : (issue.providers[0] ?? "otel")) as Incident["source"],
        fingerprint: issue.fingerprint,
        title: issue.title,
        count: issue.count,
        firstSeen: issue.firstSeen,
        lastSeen: issue.lastSeen,
        status: INCIDENT_STATUS[issue.status],
        ...(issue.ticketId ? { ticketId: issue.ticketId } : {}),
      }))
      .filter((i) => !query.status || i.status === query.status);
  }
}
