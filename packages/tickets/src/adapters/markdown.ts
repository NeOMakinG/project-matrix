import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  LinkType,
  NewTicket,
  Ticket,
  TicketPatch,
  TicketQuery,
  TicketStatus,
  TicketStore,
} from "../types.js";
import { ensureSafeDir, overwriteFile, readFileSafe, writeNewFile } from "./safe-fs";

const FRONT = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

function serialize(t: Ticket): string {
  const meta: Record<string, unknown> = {
    id: t.id,
    title: t.title,
    status: t.status,
    labels: t.labels,
    deps: t.deps,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
  for (const key of ["priority", "parent", "assignee", "phase", "url"] as const) {
    if (t[key] !== undefined) meta[key] = t[key];
  }
  const lines = Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n${t.body.trim()}\n`;
}

function parse(text: string): Ticket {
  const m = FRONT.exec(text);
  if (!m) throw new Error("ticket file is missing frontmatter");
  const meta: Record<string, unknown> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = JSON.parse(line.slice(i + 1).trim());
  }
  return { ...(meta as Omit<Ticket, "body">), body: (m[2] ?? "").trim() };
}

export interface MarkdownStoreOptions {
  /**
   * Every read and write must stay inside this directory with no symlinked path component.
   * Defaults to the parent of the tickets directory.
   */
  root?: string;
  now?: () => Date;
}

/** Tickets as markdown files with JSON-valued frontmatter, e.g. `.matrix/tickets/T-0001-title.md`. */
export class MarkdownTicketStore implements TicketStore {
  readonly kind = "markdown" as const;
  private readonly root: string;
  private readonly now: () => Date;

  constructor(
    private readonly dir: string,
    opts: MarkdownStoreOptions = {},
  ) {
    this.root = opts.root ?? dirname(dir);
    this.now = opts.now ?? (() => new Date());
  }

  private async files(): Promise<string[]> {
    await ensureSafeDir(this.root, this.dir);
    return (await readdir(this.dir)).filter((f) => /^T-\d{4,}-.*\.md$/.test(f)).sort();
  }

  private async path(id: string): Promise<string | null> {
    const f = (await this.files()).find((name) => name.startsWith(`${id}-`));
    return f ? join(this.dir, f) : null;
  }

  async list(query: TicketQuery = {}): Promise<Ticket[]> {
    const all = await Promise.all(
      (await this.files()).map(async (f) =>
        parse(await readFileSafe(this.root, join(this.dir, f))),
      ),
    );
    return all.filter(
      (t) =>
        (!query.status || query.status.includes(t.status)) &&
        (!query.labels || query.labels.every((l) => t.labels.includes(l))),
    );
  }

  async get(id: string): Promise<Ticket | null> {
    const p = await this.path(id);
    return p ? parse(await readFileSafe(this.root, p)) : null;
  }

  /**
   * Reserves the next id atomically. Ids are monotonic: they never reuse a number, even after a
   * ticket file is deleted, because every reservation leaves a marker in `.ids/`.
   */
  private async reserveId(): Promise<string> {
    const idsDir = join(this.dir, ".ids");
    await ensureSafeDir(this.root, idsDir);
    const numbers = [...(await this.files()), ...(await readdir(idsDir))]
      .map((f) => /^T-(\d{4,})/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    for (let n = Math.max(0, ...numbers) + 1; ; n++) {
      const id = `T-${String(n).padStart(4, "0")}`;
      try {
        await writeNewFile(this.root, join(idsDir, id), "");
        return id;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
  }

  async create(input: NewTicket): Promise<Ticket> {
    const id = await this.reserveId();
    const at = this.now().toISOString();
    const ticket: Ticket = {
      id,
      title: input.title,
      body: input.body,
      status: "open",
      labels: input.labels ?? [],
      deps: input.deps ?? [],
      createdAt: at,
      updatedAt: at,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
    };
    await writeNewFile(
      this.root,
      join(this.dir, `${id}-${slug(input.title)}.md`),
      serialize(ticket),
    );
    return ticket;
  }

  async update(id: string, patch: TicketPatch): Promise<Ticket> {
    const p = await this.path(id);
    if (!p) throw new Error(`ticket ${id} not found`);
    const current = parse(await readFileSafe(this.root, p));
    const next = { ...current, ...patch, updatedAt: this.now().toISOString() } as Ticket;
    await overwriteFile(this.root, p, serialize(next));
    return next;
  }

  async comment(id: string, body: string): Promise<void> {
    const t = await this.get(id);
    if (!t) throw new Error(`ticket ${id} not found`);
    await this.update(id, {
      body: `${t.body}\n\n---\n**Comment ${this.now().toISOString()}**\n\n${body}`,
    });
  }

  async link(from: string, to: string, type: LinkType): Promise<void> {
    const t = await this.get(from);
    if (!t) throw new Error(`ticket ${from} not found`);
    if (type === "parent") await this.update(from, { parent: to });
    else if (type === "blocks" && !t.deps.includes(to))
      await this.update(from, { deps: [...t.deps, to] });
    else if (type === "related" && !t.labels.includes(`related:${to}`))
      await this.update(from, { labels: [...t.labels, `related:${to}`] });
  }

  async ready(): Promise<Ticket[]> {
    const all = await this.list();
    const done = new Set(
      all.filter((t) => t.status === "done" || t.status === "closed").map((t) => t.id),
    );
    const open: TicketStatus[] = ["open", "ready"];
    return all.filter((t) => open.includes(t.status) && t.deps.every((d) => done.has(d)));
  }
}
