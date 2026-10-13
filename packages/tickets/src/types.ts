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

export interface TicketStore {
  readonly kind: "beads" | "github" | "linear" | "markdown";
  list(query?: TicketQuery): Promise<Ticket[]>;
  get(id: string): Promise<Ticket | null>;
  create(input: NewTicket): Promise<Ticket>;
  update(id: string, patch: TicketPatch): Promise<Ticket>;
  comment(id: string, body: string): Promise<void>;
  link(from: string, to: string, type: LinkType): Promise<void>;
  ready(): Promise<Ticket[]>;
}
