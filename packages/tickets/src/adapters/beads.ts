import { hostExecutor, type LineExecutor, runToCompletion } from "@matrix/sandbox";
import type {
  LinkType,
  NewTicket,
  Ticket,
  TicketPatch,
  TicketQuery,
  TicketStatus,
  TicketStore,
} from "../types.js";
import { withBeadsQueue } from "./beads-queue.js";

export interface BeadsStoreOptions {
  /** Repository containing the `.beads` database. */
  cwd: string;
  bdBinary?: string;
  executor?: LineExecutor;
  signal?: AbortSignal;
  queueWaitMs?: number;
}

const STATUS_LABEL = "matrix:status:";
const PHASE_LABEL = "matrix:phase:";

/** Matrix statuses beads has no native equivalent for are kept as a label on top of a native status. */
const TO_BEADS: Record<TicketStatus, { status: string; label?: string }> = {
  open: { status: "open" },
  ready: { status: "open", label: "ready" },
  in_progress: { status: "in_progress" },
  blocked: { status: "blocked" },
  review: { status: "in_progress", label: "review" },
  qa: { status: "in_progress", label: "qa" },
  done: { status: "closed", label: "done" },
  closed: { status: "closed" },
};

interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: number;
  labels?: string[];
  assignee?: string;
  created_at: string;
  updated_at: string;
  dependency_count?: number;
  dependencies?: Array<{ id: string; dependency_type?: string }>;
}

function fromBeadsStatus(status: string): TicketStatus {
  if (status === "in_progress" || status === "blocked" || status === "closed") return status;
  return "open";
}

function priority(value: number | undefined): Ticket["priority"] {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4
    ? value
    : undefined;
}

/** TicketStore over the `bd` CLI (JSON mode). Default backend: git-native and works offline. */
export class BeadsStore implements TicketStore {
  readonly kind = "beads" as const;
  readonly #o: BeadsStoreOptions;
  readonly #issues = new Map<string, BeadsIssue>();

  constructor(options: BeadsStoreOptions) {
    this.#o = options;
  }

  async #bd(args: string[], stdin?: string): Promise<string> {
    const result = await withBeadsQueue(
      this.#o.cwd,
      () =>
        runToCompletion(
          this.#o.executor ?? hostExecutor,
          {
            cmd: [this.#o.bdBinary ?? "bd", ...args],
            cwd: this.#o.cwd,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
            ...(stdin !== undefined ? { stdin } : {}),
            timeoutMs: 10_000,
          },
          this.#o.signal,
        ),
      this.#o.signal,
      this.#o.queueWaitMs,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `bd ${args[0]} failed (${result.exitCode}): ${result.stderrTail.trim().slice(-400)}`,
      );
    }
    return result.stdout;
  }

  async #json<T>(args: string[], stdin?: string): Promise<T> {
    const out = await this.#bd([...args, "--json"], stdin);
    return JSON.parse(out) as T;
  }

  #toTicket(issue: BeadsIssue): Ticket {
    this.#issues.set(issue.id, issue);
    const labels = issue.labels ?? [];
    const statusLabel = labels.find((l) => l.startsWith(STATUS_LABEL))?.slice(STATUS_LABEL.length);
    const phase = labels.find((l) => l.startsWith(PHASE_LABEL))?.slice(PHASE_LABEL.length);
    const deps = (issue.dependencies ?? [])
      .filter((d) => (d.dependency_type ?? "blocks") === "blocks")
      .map((d) => d.id);
    const parent = issue.dependencies?.find((d) => d.dependency_type === "parent-child")?.id;
    const p = priority(issue.priority);
    return {
      id: issue.id,
      title: issue.title,
      body: issue.description ?? "",
      status: (statusLabel as TicketStatus | undefined) ?? fromBeadsStatus(issue.status),
      labels: labels.filter((l) => !l.startsWith(STATUS_LABEL) && !l.startsWith(PHASE_LABEL)),
      deps,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      ...(p !== undefined ? { priority: p } : {}),
      ...(parent ? { parent } : {}),
      ...(issue.assignee ? { assignee: issue.assignee } : {}),
      ...(phase ? { phase } : {}),
    };
  }

  async #show(id: string): Promise<BeadsIssue | null> {
    try {
      if (!/^[A-Za-z0-9][\w.-]*$/.test(id)) return null;
      const out = await this.#json<BeadsIssue[] | BeadsIssue>(["show", id]);
      return Array.isArray(out) ? (out[0] ?? null) : out;
    } catch (error) {
      if (/not found|no issue/i.test(String(error))) return null;
      throw error;
    }
  }

  async get(id: string): Promise<Ticket | null> {
    const issue = await this.#show(id);
    return issue ? this.#toTicket(issue) : null;
  }

  async list(query: TicketQuery = {}): Promise<Ticket[]> {
    const issues = await this.#json<BeadsIssue[]>(["list", "--all", "--limit", "0"]);
    return issues.map((issue) => this.#toTicket(issue)).filter((ticket) => matches(ticket, query));
  }

  async create(input: NewTicket): Promise<Ticket> {
    const args = ["create", "--body-file", "-"];
    if (input.priority !== undefined) args.push("-p", String(input.priority));
    if (input.labels?.length) args.push("-l", input.labels.join(","));
    // `--title=` keeps the title a flag value: a leading "-" can never be parsed as an option.
    args.push(`--title=${input.title}`);
    const created = await this.#json<BeadsIssue>(args, input.body);
    for (const dep of input.deps ?? []) await this.link(dep, created.id, "blocks");
    if (input.parent) await this.link(input.parent, created.id, "parent");
    created.dependencies = [
      ...(created.dependencies ?? []),
      ...(input.deps ?? []).map((id) => ({ id, dependency_type: "blocks" })),
      ...(input.parent ? [{ id: input.parent, dependency_type: "parent-child" }] : []),
    ];
    return this.#toTicket(created);
  }

  async update(id: string, patch: TicketPatch): Promise<Ticket> {
    const needsCurrent =
      patch.labels !== undefined ||
      patch.phase !== undefined ||
      patch.deps !== undefined ||
      patch.parent !== undefined;
    let current = this.#issues.get(id);
    if (!current && needsCurrent) current = (await this.#show(id)) ?? undefined;
    if (!current && needsCurrent) throw new Error(`ticket ${id} not found`);
    const args = ["update", assertBeadsId(id)];
    let stdin: string | undefined;
    if (patch.title !== undefined) args.push(`--title=${patch.title}`);
    if (patch.body !== undefined) {
      args.push("--body-file", "-", "--allow-empty-description");
      stdin = patch.body;
    }
    if (patch.priority !== undefined) args.push("-p", String(patch.priority));
    if (patch.assignee !== undefined) args.push("-a", patch.assignee);
    const currentLabels = current?.labels ?? [];
    const labels = new Set(
      patch.labels !== undefined
        ? [
            ...patch.labels,
            ...currentLabels.filter((l) => l.startsWith(STATUS_LABEL) || l.startsWith(PHASE_LABEL)),
          ]
        : currentLabels,
    );
    if (patch.status !== undefined) {
      const mapped = TO_BEADS[patch.status];
      args.push("-s", mapped.status);
      for (const l of [...labels]) if (l.startsWith(STATUS_LABEL)) labels.delete(l);
      if (mapped.label) labels.add(`${STATUS_LABEL}${mapped.label}`);
      for (const status of Object.values(TO_BEADS))
        if (status.label && status.label !== mapped.label)
          args.push("--remove-label", `${STATUS_LABEL}${status.label}`);
    }
    if (patch.phase !== undefined) {
      for (const l of [...labels]) if (l.startsWith(PHASE_LABEL)) labels.delete(l);
      if (patch.phase) labels.add(`${PHASE_LABEL}${patch.phase}`);
    }
    const before = new Set(currentLabels);
    for (const l of labels) if (!before.has(l)) args.push("--add-label", l);
    for (const l of before) if (!labels.has(l)) args.push("--remove-label", l);
    if (args.length > 2) {
      const result = await this.#json<BeadsIssue | BeadsIssue[]>(args, stdin);
      current = Array.isArray(result) ? result[0] : result;
      if (!current) throw new Error(`bd update returned no issue for ${id}`);
    }
    if (!current) current = (await this.#show(id)) ?? undefined;
    if (!current) throw new Error(`ticket ${id} not found`);
    for (const dep of patch.deps ?? [])
      if (
        !current.dependencies?.some(
          (dependency) =>
            dependency.id === dep && (dependency.dependency_type ?? "blocks") === "blocks",
        )
      ) {
        await this.link(dep, id, "blocks");
        (current.dependencies ??= []).push({ id: dep, dependency_type: "blocks" });
      }
    if (
      patch.parent &&
      !current.dependencies?.some(
        (dependency) =>
          dependency.id === patch.parent && dependency.dependency_type === "parent-child",
      )
    ) {
      await this.link(patch.parent, id, "parent");
      (current.dependencies ??= []).push({ id: patch.parent, dependency_type: "parent-child" });
    }
    return this.#toTicket(current);
  }

  async comment(id: string, body: string): Promise<void> {
    await this.#bd(["comment", assertBeadsId(id), "--stdin"], body);
  }

  async link(from: string, to: string, type: LinkType): Promise<void> {
    assertBeadsId(from);
    assertBeadsId(to);
    if (type === "blocks") await this.#bd(["dep", "add", to, from, "-t", "blocks"]);
    else if (type === "parent") await this.#bd(["dep", "add", to, from, "-t", "parent-child"]);
    else await this.#bd(["dep", "add", from, to, "-t", "relates-to"]);
  }

  async ready(): Promise<Ticket[]> {
    const issues = await this.#json<BeadsIssue[]>(["ready", "--limit", "0"]);
    return issues
      .map((i) => this.#toTicket(i))
      .map((t) => (t.status === "open" ? { ...t, status: "ready" as const } : t));
  }
}

/** Ticket ids we pass to bd as positionals; anything else could be read as a flag. */
export function assertBeadsId(id: string): string {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(id)) throw new Error(`invalid ticket id ${JSON.stringify(id)}`);
  return id;
}

export function matches(ticket: Ticket, query: TicketQuery): boolean {
  if (query.status && !query.status.includes(ticket.status)) return false;
  if (query.labels && !query.labels.every((l) => ticket.labels.includes(l))) return false;
  return true;
}
