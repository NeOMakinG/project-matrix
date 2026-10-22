export type TicketStatus =
  | "open"
  | "ready"
  | "in_progress"
  | "blocked"
  | "review"
  | "qa"
  | "done"
  | "closed";

export type LinkType = "blocks" | "parent" | "related";

export interface Ticket {
  id: string;
  title: string;
  body: string;
  status: TicketStatus;
  labels: string[];
  estimate?: number;
  priority?: 0 | 1 | 2 | 3 | 4;
  deps: string[];
  parent?: string;
  assignee?: string;
  phase?: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewTicket {
  title: string;
  body: string;
  labels?: string[];
  estimate?: number;
  priority?: Ticket["priority"];
  parent?: string;
  deps?: string[];
}

export type TicketPatch = Partial<Omit<Ticket, "id" | "createdAt" | "updatedAt">>;

export interface TicketQuery {
  status?: TicketStatus[];
  labels?: string[];
}

/** Workflow position reported to trackers that model the pipeline as board columns. */
export interface TrackerPhase {
  /** Matrix phase, e.g. `spike`, `implement`, `merge`. */
  phase: string;
  /** Workflow status: pending, running, waiting_approval, blocked or done. */
  status: string;
}

export interface TicketStore {
  readonly kind: "beads" | "github" | "linear" | "markdown";
  list(query?: TicketQuery): Promise<Ticket[]>;
  get(id: string): Promise<Ticket | null>;
  create(input: NewTicket): Promise<Ticket>;
  update(id: string, patch: TicketPatch): Promise<Ticket>;
  comment(id: string, body: string): Promise<void>;
  link(from: string, to: string, type: LinkType): Promise<void>;
  ready(): Promise<Ticket[]>;
  /**
   * Optional: move the ticket to the board column for a workflow phase. Adapters without
   * per-phase columns leave it undefined; callers then rely on `update({ status })` alone.
   */
  setPhase?(id: string, position: TrackerPhase): Promise<void>;
  /**
   * Optional: keep one comment per `key` on the ticket, created once and edited in place.
   * Adapters that cannot edit comments leave it undefined (callers then post nothing).
   */
  upsertComment?(id: string, key: string, body: string): Promise<void>;
  /** Optional: create tracker-side scoping the store relies on (e.g. a project label). */
  ensureScope?(): Promise<void>;
}
