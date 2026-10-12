import type {
  LinkType,
  NewTicket,
  Ticket,
  TicketPatch,
  TicketQuery,
  TicketStore,
} from "@matrix/tickets";
import type {
  ChatRequest,
  Deployment,
  GraphPort,
  LlmClient,
  Notification,
  Notifier,
  ReleasePort,
} from "./ports.js";
import type { RawSignal, SignalSource } from "./signal.js";

/** In-memory TicketStore for tests and dry runs. */
export class FakeTicketStore implements TicketStore {
  readonly kind = "markdown" as const;
  readonly tickets = new Map<string, Ticket>();
  readonly comments: { id: string; body: string }[] = [];
  readonly links: { from: string; to: string; type: LinkType }[] = [];
  private seq = 0;

  async list(q?: TicketQuery) {
    return [...this.tickets.values()].filter(
      (t) =>
        (!q?.status || q.status.includes(t.status)) &&
        (!q?.labels || q.labels.every((l) => t.labels.includes(l))),
    );
  }
  async get(id: string) {
    return this.tickets.get(id) ?? null;
  }
  async create(input: NewTicket) {
    const now = "2026-10-12T00:00:00.000Z";
    const t: Ticket = {
      id: `T-${++this.seq}`,
      title: input.title,
      body: input.body,
      status: "open",
      labels: input.labels ?? [],
      deps: input.deps ?? [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.priority !== undefined) t.priority = input.priority;
    if (input.parent !== undefined) t.parent = input.parent;
    this.tickets.set(t.id, t);
    return t;
  }
  async update(id: string, patch: TicketPatch) {
    const t = this.tickets.get(id);
    if (!t) throw new Error(`no ticket ${id}`);
    const next = { ...t, ...patch } as Ticket;
    this.tickets.set(id, next);
    return next;
  }
  async comment(id: string, body: string) {
    this.comments.push({ id, body });
  }
  async link(from: string, to: string, type: LinkType) {
    this.links.push({ from, to, type });
  }
  async ready() {
    return this.list({ status: ["ready"] });
  }
}

/** Returns scripted completions in order and records every request. */
export class ScriptedLlm implements LlmClient {
  readonly requests: ChatRequest[] = [];
  constructor(private readonly replies: (string | Error)[]) {}

  async complete(req: ChatRequest) {
    this.requests.push(req);
    const next = this.replies.shift();
    if (next === undefined) throw new Error("no scripted reply left");
    if (next instanceof Error) throw next;
    return next;
  }
}

const REPO_FILES = ["src/", "api/"];

export const fakeGraph: GraphPort = {
  async hintsFor({ frames }) {
    return frames
      .filter((f) => f.inApp)
      .map((f) => ({
        path: f.file,
        ...(f.function ? { symbol: f.function } : {}),
        reason: "stack frame",
        adrs: f.file.startsWith("src/billing") ? ["ADR-0007"] : [],
        features: f.file.startsWith("src/billing") ? ["invoicing"] : [],
        // The fake repo: everything under src/ and api/ exists in the code graph.
        inRepo: REPO_FILES.some((prefix) => f.file.startsWith(prefix)),
      }));
  },
};

export const staticReleases = (deployments: Deployment[]): ReleasePort => ({
  async deployments() {
    return deployments;
  },
});

export class RecordingNotifier implements Notifier {
  readonly sent: Notification[] = [];
  async notify(n: Notification) {
    this.sent.push(n);
  }
}

export class QueueSource implements SignalSource {
  constructor(public queue: RawSignal[] = []) {}
  async pull(since: string) {
    const out = this.queue.filter((r) => Date.parse(r.receivedAt) > Date.parse(since));
    this.queue = [];
    return out;
  }
}

export const raw = (
  source: RawSignal["source"],
  payload: unknown,
  receivedAt = "2026-10-12T09:30:00.000Z",
): RawSignal => ({ source, kind: "test", title: `${source} signal`, payload, receivedAt });
