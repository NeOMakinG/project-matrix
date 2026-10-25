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
  /** Optional: add one label to the ticket (created on the tracker when missing). */
  addLabel?(id: string, label: string): Promise<void>;
  /**
   * Optional: upload a file for embedding in a later comment; returns its https asset URL.
   * Trackers without uploads leave it undefined (callers then list file names only).
   */
  uploadFile?(id: string, name: string, contentType: string, bytes: Uint8Array): Promise<string>;
  /** Optional: remove one label from the ticket; a missing label is a no-op. */
  removeLabel?(id: string, label: string): Promise<void>;
  /**
   * Optional: the ticket's comments, oldest first, already sanitized. `byMatrix` is true only for
   * comments this Matrix instance authored (tracker identity AND Matrix's hidden marker).
   */
  listComments?(id: string): Promise<TicketComment[]>;
  /**
   * Optional: which of `ids` a human moved back to a not-started column (Backlog, Todo, Triage;
   * never Ready). Matrix never writes those columns while a workflow runs, so for an active
   * workflow this is a human stop request. Returns the column each one sits in.
   */
  stopRequests?(ids: string[]): Promise<StopRequest[]>;
}

export interface StopRequest {
  id: string;
  /** Tracker column the ticket was moved to, e.g. "Backlog". */
  column: string;
}

export interface TicketComment {
  id: string;
  body: string;
  /** True for comments Matrix itself posted; callers must not feed them back into prompts. */
  byMatrix: boolean;
  /**
   * True only when the Matrix identity itself posted it (and it carries the marker). `byMatrix`
   * also accepts marked legacy comments, so any commenter can forge it; authority decisions (a
   * prior QA verdict) must use this instead. Absent: the store cannot tell, use `byMatrix`.
   */
  authoredByMatrix?: boolean;
  author?: string;
  createdAt?: string;
}

/** Hidden marker appended to every comment Matrix posts, so it can recognize its own comments. */
export const MATRIX_COMMENT_MARKER = "<!-- matrix:bot -->";

/** Label Matrix adds when it blocks a ticket and removes when the ticket is re-queued. */
export const NEEDS_HUMAN_LABEL = "needs-human";
