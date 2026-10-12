import type {
  LinkType,
  NewTicket,
  Ticket,
  TicketPatch,
  TicketQuery,
  TicketStore,
} from "../types.js";
import { matches } from "./beads.js";

const DONE = new Set(["done", "closed"]);

/** In-memory TicketStore. Reference semantics for the contract suite and a fake for orchestrator tests. */
export class MemoryStore implements TicketStore {
  readonly kind = "markdown" as const;
  readonly #tickets = new Map<string, Ticket>();
  readonly comments = new Map<string, string[]>();
  #seq = 0;
  readonly #now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now;
  }

  async list(query: TicketQuery = {}): Promise<Ticket[]> {
    return [...this.#tickets.values()]
      .filter((t) => matches(t, query))
      .map((t) => structuredClone(t));
  }

  async get(id: string): Promise<Ticket | null> {
    const t = this.#tickets.get(id);
    return t ? structuredClone(t) : null;
  }

  async create(input: NewTicket): Promise<Ticket> {
    this.#seq += 1;
    const at = this.#now();
    const ticket: Ticket = {
      id: `mem-${this.#seq}`,
      title: input.title,
      body: input.body,
      status: "open",
      labels: input.labels ?? [],
      deps: input.deps ?? [],
      createdAt: at,
      updatedAt: at,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.parent ? { parent: input.parent } : {}),
    };
    this.#tickets.set(ticket.id, ticket);
    return structuredClone(ticket);
  }

  async update(id: string, patch: TicketPatch): Promise<Ticket> {
    const t = this.#tickets.get(id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const next = { ...t, ...patch, updatedAt: this.#now() } as Ticket;
    this.#tickets.set(id, next);
    return structuredClone(next);
  }

  async comment(id: string, body: string): Promise<void> {
    if (!this.#tickets.has(id)) throw new Error(`ticket ${id} not found`);
    this.comments.set(id, [...(this.comments.get(id) ?? []), body]);
  }

  async link(from: string, to: string, type: LinkType): Promise<void> {
    const t = this.#tickets.get(to);
    if (!t || !this.#tickets.has(from)) throw new Error("ticket not found");
    if (type === "blocks") t.deps = [...new Set([...t.deps, from])];
    else if (type === "parent") t.parent = from;
  }

  async ready(): Promise<Ticket[]> {
    return [...this.#tickets.values()]
      .filter((t) => t.status === "open" || t.status === "ready")
      .filter((t) => t.deps.every((d) => DONE.has(this.#tickets.get(d)?.status ?? "closed")))
      .map((t) => ({ ...structuredClone(t), status: "ready" as const }));
  }
}
