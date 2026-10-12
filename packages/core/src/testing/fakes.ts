import type { NewTicket, Ticket, TicketPatch, TicketQuery, TicketStore } from "@matrix/tickets";
import type {
  PreparedWorkspace,
  Receipt,
  Runner,
  RunnerId,
  RunRequest,
  RunResult,
  Sandbox,
  SandboxExecResult,
  SandboxExecSpec,
  Workspace,
  WorkspaceTarget,
} from "../ports.js";
import type { ProjectConfig } from "../types.js";

export class FakeTicketStore implements TicketStore {
  readonly kind = "markdown" as const;
  readonly tickets = new Map<string, Ticket>();
  readonly comments: { id: string; body: string }[] = [];
  private seq = 0;

  add(title: string, priority: Ticket["priority"] = 2): Ticket {
    const now = new Date().toISOString();
    const t: Ticket = {
      id: `T-${++this.seq}`,
      title,
      body: `${title} body`,
      status: "ready",
      labels: [],
      priority,
      deps: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tickets.set(t.id, t);
    return t;
  }
  async list(q?: TicketQuery) {
    return [...this.tickets.values()].filter((t) => !q?.status || q.status.includes(t.status));
  }
  async get(id: string) {
    return this.tickets.get(id) ?? null;
  }
  async create(input: NewTicket) {
    const t = this.add(input.title, input.priority);
    return { ...t, body: input.body };
  }
  async update(id: string, patch: TicketPatch) {
    const t = this.tickets.get(id);
    if (!t) throw new Error(`no ticket ${id}`);
    const next = { ...t, ...patch, updatedAt: new Date().toISOString() } as Ticket;
    this.tickets.set(id, next);
    return next;
  }
  async comment(id: string, body: string) {
    this.comments.push({ id, body });
  }
  async link() {}
  async ready() {
    return [...this.tickets.values()].filter((t) => t.status === "ready");
  }
}

export type Script = (
  req: RunRequest,
  signal: AbortSignal,
) => Partial<RunResult> | Promise<Partial<RunResult>>;

/** A runner whose answers are scripted per phase; records every request it receives. */
export class FakeRunner implements Runner {
  readonly calls: RunRequest[] = [];
  constructor(
    readonly id: RunnerId,
    private readonly script: Script,
  ) {}
  async run(
    req: RunRequest,
    onEvent: Parameters<Runner["run"]>[1],
    signal: AbortSignal,
  ): Promise<RunResult> {
    this.calls.push(req);
    onEvent({
      runId: req.runId,
      at: new Date().toISOString(),
      kind: "log",
      message: `${req.phase} on ${req.model}`,
    });
    const partial = await this.script(req, signal);
    if (signal.aborted)
      return { runId: req.runId, status: "cancelled", summary: "aborted", receipts: [] };
    return { runId: req.runId, status: "ok", summary: "", receipts: [], costUsd: 0.01, ...partial };
  }
}

export class FakeSandbox implements Sandbox {
  readonly kind = "bwrap" as const;
  readonly calls: SandboxExecSpec[] = [];
  constructor(private readonly codes: (spec: SandboxExecSpec) => number = () => 0) {}
  async exec(spec: SandboxExecSpec): Promise<SandboxExecResult> {
    this.calls.push(spec);
    return { code: this.codes(spec), stdout: "ok", stderr: "" };
  }
}

export class FakeWorkspace implements Workspace {
  readonly kind = "native" as const;
  readonly prepared: WorkspaceTarget[] = [];
  readonly cleaned: string[] = [];
  async prepare(target: WorkspaceTarget): Promise<PreparedWorkspace> {
    // Every prepare yields a fresh worktree path, like a new git worktree on the same branch.
    const n = this.prepared.filter((p) => p.ticketId === target.ticketId).length;
    this.prepared.push(target);
    return { workdir: `/tmp/wt/${target.ticketId}-${n}`, ref: `wt-${target.ticketId}-${n}` };
  }
  async cleanup(prepared: PreparedWorkspace) {
    this.cleaned.push(prepared.ref);
  }
}

export const qaEvidence = (ok = true): Receipt[] => [
  { kind: "screenshot", ok, summary: "home.png" },
  { kind: "test", ok, summary: "e2e 3/3" },
];

export function testProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "pilot",
    name: "Pilot",
    repoPath: "/repo/pilot",
    baseBranch: "main",
    host: "bosgame",
    models: {
      implement: { runner: "claude-code", model: "fable-5-1" },
      review: { runner: "codex", model: "gpt-6.1-sol" },
    },
    reviewerFallbacks: [{ runner: "opencode", model: "glm-5.3" }],
    autonomy: { default: "autonomous" },
    reviewLanes: ["correctness-security", "architecture-adr"],
    checks: [
      { kind: "typecheck", cmd: ["bun", "run", "typecheck"] },
      { kind: "test", cmd: ["bun", "run", "test"] },
    ],
    holdoutThreshold: 0.8,
    maxLoops: 3,
    maxAttempts: 3,
    runTimeoutMs: 60_000,
    ...overrides,
  };
}

/** Git state per worktree; tests mutate it to simulate commits and dirty trees. */
export class FakeGit {
  readonly sha = new Map<string, string>();
  readonly dirty = new Map<string, string>();
  async headSha(workdir: string): Promise<string> {
    return this.sha.get(workdir) ?? "a".repeat(40);
  }
  async treeState(workdir: string): Promise<string> {
    return `${await this.headSha(workdir)}:${this.dirty.get(workdir) ?? ""}`;
  }
  async isClean(workdir: string): Promise<boolean> {
    return !this.dirty.get(workdir);
  }
  commit(workdir: string, sha: string): void {
    this.sha.set(workdir, sha);
  }
}
