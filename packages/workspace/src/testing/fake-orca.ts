import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import type { LineExecutor } from "@matrix/sandbox";
import { ORCA_REQUIRED_COMMANDS } from "../orca.js";

interface Message {
  id: string;
  type: string;
  from_handle: string;
  subject: string;
  body: string;
  payload: string;
}

/**
 * In-memory stand-in for the Orca CLI (no live Orca in unit tests). `terminal send` really runs the
 * runner script with bash; `worker_done` is queued when it exits (unless `dropWorkerDone`).
 */
export class FakeOrca {
  calls: string[][] = [];
  repos: Array<{ id: string; path: string }> = [];
  worktreeRoot = "/tmp";
  dropWorkerDone = false;
  askQuestion = false;
  closed = new Set<string>();
  interrupted = new Set<string>();
  acked = new Set<string>();
  replies: Array<{ id: string; body: string }> = [];
  /** Orca's `branchPrefix: git-username` setting: worktree branches become `<prefix>/<name>`. */
  branchPrefix = "";
  /** Run ids `run-use` may bind; unknown ids fail like the real runtime. */
  runs = new Set<string>();
  readonly #queue: Message[] = [];
  #delivery: { id: string; messages: Message[] } | undefined;
  #n = 0;
  readonly #children = new Map<string, ChildProcess>();
  readonly #dispatchByTerminal = new Map<string, { task: string; dispatch: string }>();

  #id(prefix: string): string {
    this.#n += 1;
    return `${prefix}_${this.#n}`;
  }

  #flag(args: string[], name: string): string {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? (args[i + 1] ?? "") : "";
  }

  push(type: string, dispatch: string, extra: Partial<Message> = {}): void {
    this.#queue.push({
      id: this.#id("msg"),
      type,
      from_handle: `dispatch:${dispatch}`,
      subject: type,
      body: "",
      payload: JSON.stringify({ dispatchId: dispatch, outcome: "succeeded" }),
      ...extra,
    });
  }

  pending(): number {
    return this.#queue.length + (this.#delivery ? this.#delivery.messages.length : 0);
  }

  /** Flags Orca's usage line marks as required; the real CLI refuses calls without them. */
  static readonly REQUIRED: Record<string, string[]> = {
    "orchestration task-create": ["spec"],
    "orchestration dispatch": ["task", "to"],
    "orchestration run-create": ["objective"],
    "orchestration run-use": ["id"],
    "worktree create": ["name"],
  };

  #handle(args: string[]): unknown {
    const cmd = `${args[0]} ${args[1]}`;
    for (const flag of FakeOrca.REQUIRED[cmd] ?? [])
      if (!this.#flag(args, flag)) throw new Error(`Missing required --${flag}`);
    switch (cmd) {
      case "agent-context --json":
        return {
          schemaVersion: 1,
          commands: Object.entries(ORCA_REQUIRED_COMMANDS).map(([command, flags]) => ({
            command,
            flags,
          })),
        };
      case "repo add": {
        const path = this.#flag(args, "path") ?? "";
        const repo = { id: `r${this.repos.length + 1}`, path };
        this.repos.push(repo);
        return { repo };
      }
      case "repo list":
        return { repos: this.repos };
      case "worktree create": {
        const name = this.#flag(args, "name");
        const repo = this.repos.find((r) => `id:${r.id}` === this.#flag(args, "repo"));
        if (!repo) throw new Error("unknown repo");
        const path = join(this.worktreeRoot, name);
        const base = this.#flag(args, "base-branch");
        const branch = this.branchPrefix ? `${this.branchPrefix}/${name}` : name;
        execFileSync("git", ["-C", repo.path, "worktree", "add", "-q", "-b", branch, path, base]);
        return { worktree: { id: `wt-${name}`, path, branch: `refs/heads/${branch}` } };
      }
      case "worktree rm":
        return { removed: true };
      case "terminal create":
        return { terminal: { handle: this.#id("term"), title: this.#flag(args, "title") } };
      case "terminal close":
        this.closed.add(this.#flag(args, "terminal"));
        this.#children.get(this.#flag(args, "terminal"))?.kill("SIGKILL");
        return { closed: true };
      case "orchestration run-create": {
        const id = this.#id("run");
        this.runs.add(id);
        return { run: { id } };
      }
      case "orchestration run-use": {
        const id = this.#flag(args, "id");
        if (!this.runs.has(id)) throw new Error(`Run not found: ${id}`);
        return { run: { id } };
      }
      case "orchestration task-create":
        return { task: { id: this.#id("task") } };
      case "orchestration dispatch": {
        const dispatch = this.#id("ctx");
        this.#dispatchByTerminal.set(this.#flag(args, "to"), {
          task: this.#flag(args, "task"),
          dispatch,
        });
        return { dispatch: { id: dispatch, status: "dispatched" } };
      }
      case "terminal send":
        return this.#send(args);
      case "orchestration check":
        return this.#check(args);
      case "orchestration reply":
        this.replies.push({ id: this.#flag(args, "id"), body: this.#flag(args, "body") });
        return { replied: true };
      case "orchestration worker-read":
        return { source: "terminal", terminal: { tail: ["matrix phase finished: exit 0"] } };
      default:
        throw new Error(`fake orca: unsupported ${cmd}`);
    }
  }

  #send(args: string[]): unknown {
    const terminal = this.#flag(args, "terminal");
    if (args.includes("--interrupt")) {
      this.interrupted.add(terminal);
      this.#children.get(terminal)?.kill("SIGKILL");
      return { sent: true };
    }
    const text = this.#flag(args, "text");
    const match = /^bash '([^']+)'; exit$/.exec(text);
    if (!match) throw new Error(`fake orca: unexpected terminal text ${text}`);
    const work = this.#dispatchByTerminal.get(terminal);
    if (!work) throw new Error("terminal has no dispatch");
    if (this.askQuestion) this.push("question", work.dispatch, { body: "proceed?" });
    const child = spawn("bash", [match[1] as string], { stdio: "ignore" });
    this.#children.set(terminal, child);
    child.on("exit", () => {
      this.#children.delete(terminal);
      if (!this.dropWorkerDone && !this.interrupted.has(terminal))
        this.push("worker_done", work.dispatch);
    });
    return { sent: true };
  }

  async #check(args: string[]): Promise<unknown> {
    const ack = this.#flag(args, "ack");
    if (ack && this.#delivery?.id === ack) {
      this.acked.add(ack);
      this.#delivery = undefined;
    }
    if (!this.#delivery && args.includes("--wait") && this.#queue.length === 0)
      await new Promise((r) => setTimeout(r, Math.min(Number(this.#flag(args, "timeout-ms")), 50)));
    // An unacked Delivery replays first, like the real runtime.
    if (!this.#delivery && this.#queue.length > 0)
      this.#delivery = { id: this.#id("dlv"), messages: this.#queue.splice(0) };
    if (!this.#delivery) return { messages: [], count: 0, timedOut: true };
    return {
      deliveryId: this.#delivery.id,
      messages: this.#delivery.messages,
      count: this.#delivery.messages.length,
    };
  }

  executor(): LineExecutor {
    return async (spec, onLine) => {
      const args = spec.cmd.slice(1);
      this.calls.push(args);
      try {
        const result = await this.#handle(args);
        onLine(JSON.stringify({ ok: true, result }));
        return { exitCode: 0, timedOut: false, cancelled: false, stderrTail: "" };
      } catch (error) {
        onLine(JSON.stringify({ ok: false, error: { message: (error as Error).message } }));
        return { exitCode: 1, timedOut: false, cancelled: false, stderrTail: "" };
      }
    };
  }
}
