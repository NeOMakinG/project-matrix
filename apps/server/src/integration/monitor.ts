import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { adrsGoverning, featuresForPath, loadProductGraph, readCodeGraph } from "@matrix/graph";
import {
  framesOnlyGraph,
  type GraphPort,
  type Issue,
  type LlmClient,
  Monitor,
  type RawSignal,
  type SignalSource,
  type TickResult,
} from "@matrix/monitor";
import type { TicketStore } from "@matrix/tickets";
import type { Incident, IncidentStatus, MonitorSignal } from "../core-port.js";
import { PrivateState } from "../private-state.js";
import type { PrivateStateOwner } from "../state-owner.js";
import { PersistentIssueStore } from "./monitor-store.js";
import type { MonitorPort } from "./real-core.js";

/** Webhook signals as received by the server; the monitor pulls them by time. */
export class SignalBuffer {
  private readonly signals: RawSignal[];
  private readonly state: PrivateState<RawSignal[]>;

  constructor(
    private readonly max = 10_000,
    file?: string,
    private readonly owner?: PrivateStateOwner,
  ) {
    if (file && !owner) throw new Error("durable signal buffer requires lifetime ownership");
    this.state = new PrivateState(file, owner);
    this.signals = this.state.load([]);
  }

  push(signal: MonitorSignal): void {
    this.owner?.assertOwned();
    this.signals.push(signal as RawSignal);
    if (this.signals.length > this.max) this.signals.shift();
    this.state.save(this.signals);
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
  stateOwner?: PrivateStateOwner;
  dataDir?: string;
  repoPath?: (projectId: string) => Promise<string>;
  trackerVisibility?: (projectId: string) => Promise<"private" | "public">;
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
  readonly buffer: SignalBuffer;
  readonly issues: PersistentIssueStore;
  private readonly monitors = new Map<string, Monitor>();

  constructor(private readonly wiring: MonitorWiring) {
    this.buffer = new SignalBuffer(
      10_000,
      wiring.dataDir ? join(wiring.dataDir, "monitor-signals.json") : undefined,
      wiring.stateOwner,
    );
    this.issues = new PersistentIssueStore(
      wiring.dataDir ? join(wiring.dataDir, "monitor-issues.json") : undefined,
      wiring.stateOwner,
    );
  }

  private readonly graph: GraphPort = {
    hintsFor: async (input) => {
      const hints = await framesOnlyGraph.hintsFor(input);
      if (!this.wiring.repoPath) return hints;
      const root = await this.wiring.repoPath(input.projectId);
      const code = await readCodeGraph(root);
      const product = await loadProductGraph(root);
      for (const hint of hints) {
        hint.inRepo = code?.modules.some((module) => module.path === hint.path) ?? false;
        hint.features = featuresForPath(product, hint.path).map((feature) => feature.id);
        hint.adrs = adrsGoverning(hint.path, [], product);
      }
      return hints;
    },
  };

  async ingest(signal: MonitorSignal): Promise<{ id: string }> {
    this.buffer.push(signal);
    return { id: randomUUID() };
  }

  private async monitorFor(projectId: string): Promise<Monitor> {
    this.wiring.stateOwner?.assertOwned();
    const existing = this.monitors.get(projectId);
    if (existing) return existing;
    const tickets = await this.wiring.tickets(projectId);
    this.wiring.stateOwner?.assertOwned();
    const monitor = new Monitor({
      source: this.buffer.sourceFor(projectId),
      store: this.wiring.stateOwner?.fence(this.issues) ?? this.issues,
      tickets: this.wiring.stateOwner?.fence(tickets) ?? tickets,
      // Local trackers (markdown, beads) are private to the factory host.
      trackerVisibility: (await this.wiring.trackerVisibility?.(projectId)) ?? "private",
      llm: this.wiring.stateOwner?.fence(this.wiring.llm) ?? this.wiring.llm,
      graph: this.wiring.stateOwner?.fence(this.graph) ?? this.graph,
      releases: { deployments: async () => [] },
      model: this.wiring.model,
      defaultProjectId: projectId,
    });
    this.wiring.stateOwner?.assertOwned();
    this.monitors.set(projectId, monitor);
    return monitor;
  }

  async tick(): Promise<Record<string, TickResult>> {
    this.wiring.stateOwner?.assertOwned();
    const out: Record<string, TickResult> = {};
    for (const projectId of await this.wiring.projectIds()) {
      const monitor = await this.monitorFor(projectId);
      out[projectId] = this.wiring.stateOwner
        ? await this.wiring.stateOwner.guard(() => monitor.tick())
        : await monitor.tick();
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
