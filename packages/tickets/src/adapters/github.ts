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
import { matches } from "./beads.js";

export interface GitHubStoreOptions {
  /** `owner/name`. */
  repo: string;
  ghBinary?: string;
  executor?: LineExecutor;
  cwd?: string;
}

interface GhIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface MatrixMeta {
  status?: TicketStatus;
  phase?: string;
  priority?: Ticket["priority"];
  deps?: string[];
  parent?: string;
  related?: string[];
}

const FIELDS = "number,title,body,state,labels,assignees,createdAt,updatedAt,url";
const META_RE = /\n*<!-- matrix:(\{.*?\}) -->\s*$/s;

/** Matrix keeps its fields in a hidden block at the end of the issue body. */
export function splitBody(body: string): { text: string; meta: MatrixMeta } {
  const match = META_RE.exec(body);
  if (!match?.[1]) return { text: body, meta: {} };
  try {
    return { text: body.slice(0, match.index), meta: JSON.parse(match[1]) as MatrixMeta };
  } catch {
    return { text: body, meta: {} };
  }
}

export function joinBody(text: string, meta: MatrixMeta): string {
  const clean: MatrixMeta = Object.fromEntries(
    Object.entries(meta).filter(
      ([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0),
    ),
  );
  if (Object.keys(clean).length === 0) return text;
  return `${text.trimEnd()}\n\n<!-- matrix:${JSON.stringify(clean)} -->`;
}

const CLOSED_STATUSES = new Set<TicketStatus>(["done", "closed"]);

/** TicketStore over GitHub Issues through the `gh` CLI. */
export class GitHubStore implements TicketStore {
  readonly kind = "github" as const;
  readonly #o: GitHubStoreOptions;

  constructor(options: GitHubStoreOptions) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error(`invalid repo ${options.repo}`);
    this.#o = options;
  }

  async #gh(args: string[], stdin?: string): Promise<string> {
    const result = await runToCompletion(this.#o.executor ?? hostExecutor, {
      // `-R` sits right after the subcommand so a later `--` still ends flag parsing.
      cmd: [this.#o.ghBinary ?? "gh", ...args.slice(0, 2), "-R", this.#o.repo, ...args.slice(2)],
      cwd: this.#o.cwd ?? process.cwd(),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        GH_PROMPT_DISABLED: "1",
        ...(process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {}),
      },
      ...(stdin !== undefined ? { stdin } : {}),
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `gh ${args.slice(0, 2).join(" ")} failed (${result.exitCode}): ${result.stderrTail.trim().slice(-400)}`,
      );
    }
    return result.stdout;
  }

  #toTicket(issue: GhIssue): Ticket {
    const { text, meta } = splitBody(issue.body ?? "");
    const closed = issue.state.toUpperCase() === "CLOSED";
    let status: TicketStatus = meta.status ?? (closed ? "closed" : "open");
    if (closed && !CLOSED_STATUSES.has(status)) status = "closed";
    const assignee = issue.assignees?.[0]?.login;
    return {
      id: String(issue.number),
      title: issue.title,
      body: text,
      status,
      labels: issue.labels.map((l) => l.name),
      deps: meta.deps ?? [],
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      url: issue.url,
      ...(meta.priority !== undefined ? { priority: meta.priority } : {}),
      ...(meta.parent ? { parent: meta.parent } : {}),
      ...(meta.phase ? { phase: meta.phase } : {}),
      ...(assignee ? { assignee } : {}),
    };
  }

  async #issue(id: string): Promise<GhIssue | null> {
    if (!/^\d+$/.test(id)) return null;
    try {
      return JSON.parse(await this.#gh(["issue", "view", id, "--json", FIELDS])) as GhIssue;
    } catch (error) {
      if (/not found|could not resolve/i.test(String(error))) return null;
      throw error;
    }
  }

  async get(id: string): Promise<Ticket | null> {
    const issue = await this.#issue(id);
    return issue ? this.#toTicket(issue) : null;
  }

  async list(query: TicketQuery = {}): Promise<Ticket[]> {
    const issues = JSON.parse(
      await this.#gh(["issue", "list", "--state", "all", "--limit", "1000", "--json", FIELDS]),
    ) as GhIssue[];
    return issues.map((i) => this.#toTicket(i)).filter((t) => matches(t, query));
  }

  async #ensureLabels(labels: string[]): Promise<void> {
    for (const label of labels) await this.#gh(["label", "create", "--force", "--", label]);
  }

  async create(input: NewTicket): Promise<Ticket> {
    const labels = input.labels ?? [];
    await this.#ensureLabels(labels);
    const meta: MatrixMeta = {
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.deps?.length ? { deps: input.deps } : {}),
      ...(input.parent ? { parent: input.parent } : {}),
    };
    const args = ["issue", "create", "--title", input.title, "--body-file", "-"];
    for (const label of labels) args.push("--label", label);
    const url = (await this.#gh(args, joinBody(input.body, meta))).trim().split("\n").pop() ?? "";
    const number = /\/issues\/(\d+)/.exec(url)?.[1];
    if (!number) throw new Error(`could not parse issue number from gh output: ${url}`);
    const created = await this.get(number);
    if (!created) throw new Error(`issue ${number} not found after create`);
    return created;
  }

  async update(id: string, patch: TicketPatch): Promise<Ticket> {
    const issue = await this.#issue(id);
    if (!issue) throw new Error(`ticket ${id} not found`);
    const { text, meta } = splitBody(issue.body ?? "");
    const nextMeta: MatrixMeta = {
      ...meta,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.deps !== undefined ? { deps: patch.deps } : {}),
      ...(patch.parent !== undefined ? { parent: patch.parent } : {}),
    };
    const args = ["issue", "edit", id, "--body-file", "-"];
    if (patch.title !== undefined) args.push("--title", patch.title);
    if (patch.assignee !== undefined) args.push("--add-assignee", patch.assignee);
    if (patch.labels !== undefined) {
      const current = new Set(issue.labels.map((l) => l.name));
      const next = new Set(patch.labels);
      await this.#ensureLabels([...next].filter((l) => !current.has(l)));
      for (const l of next) if (!current.has(l)) args.push("--add-label", l);
      for (const l of current) if (!next.has(l)) args.push("--remove-label", l);
    }
    await this.#gh(args, joinBody(patch.body ?? text, nextMeta));
    if (patch.status !== undefined) {
      const closed = issue.state.toUpperCase() === "CLOSED";
      const shouldClose = CLOSED_STATUSES.has(patch.status);
      if (shouldClose && !closed) {
        await this.#gh([
          "issue",
          "close",
          id,
          "--reason",
          patch.status === "done" ? "completed" : "not planned",
        ]);
      } else if (!shouldClose && closed) await this.#gh(["issue", "reopen", id]);
    }
    const updated = await this.get(id);
    if (!updated) throw new Error(`ticket ${id} vanished after update`);
    return updated;
  }

  async comment(id: string, body: string): Promise<void> {
    if (!/^\d+$/.test(id)) throw new Error(`invalid issue id ${JSON.stringify(id)}`);
    await this.#gh(["issue", "comment", id, "--body-file", "-"], body);
  }

  async addLabel(id: string, label: string): Promise<void> {
    if (!/^\d+$/.test(id)) throw new Error(`invalid issue id ${JSON.stringify(id)}`);
    await this.#ensureLabels([label]);
    await this.#gh(["issue", "edit", id, "--add-label", label]);
  }

  async removeLabel(id: string, label: string): Promise<void> {
    if (!/^\d+$/.test(id)) throw new Error(`invalid issue id ${JSON.stringify(id)}`);
    const issue = await this.#issue(id);
    if (!issue?.labels.some((l) => l.name === label)) return;
    await this.#gh(["issue", "edit", id, "--remove-label", label]);
  }

  async link(from: string, to: string, type: LinkType): Promise<void> {
    if (!/^\d+$/.test(from)) throw new Error(`invalid issue id ${JSON.stringify(from)}`);
    const target = await this.#issue(to);
    if (!target) throw new Error(`ticket ${to} not found`);
    const { text, meta } = splitBody(target.body ?? "");
    if (type === "blocks") meta.deps = [...new Set([...(meta.deps ?? []), from])];
    else if (type === "parent") meta.parent = from;
    else meta.related = [...new Set([...(meta.related ?? []), from])];
    await this.#gh(["issue", "edit", to, "--body-file", "-"], joinBody(text, meta));
  }

  async ready(): Promise<Ticket[]> {
    const all = await this.list();
    const byId = new Map(all.map((t) => [t.id, t]));
    return all
      .filter((t) => t.status === "open" || t.status === "ready")
      .filter((t) => t.deps.every((d) => CLOSED_STATUSES.has(byId.get(d)?.status ?? "closed")))
      .map((t) => ({ ...t, status: "ready" as const }));
  }
}
