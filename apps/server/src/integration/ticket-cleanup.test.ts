import type { WorkflowState } from "@matrix/core";
import { describe, expect, it } from "vitest";
import {
  dirtyEntries,
  finishedFromEvidence,
  type OrcaTerminalRow,
  type PrInfo,
  parseTerminalList,
  RECENT_OUTPUT_MS,
  SETTLE_MS,
  TicketCleanup,
  type TicketCleanupPorts,
  terminalBusy,
} from "./ticket-cleanup.js";

const NOW = 1_800_000_000_000;
const WD = "/w/matrix-NEO-7";
const HEAD = "a".repeat(40);

function wf(over: Partial<WorkflowState> = {}): WorkflowState {
  return {
    projectId: "p1",
    ticketId: "NEO-7",
    phase: "merge",
    status: "done",
    attempt: 0,
    loops: 0,
    priority: 2,
    workdir: WD,
    workspaceRef: "{}",
    version: 3,
    ...over,
  };
}

interface Opts {
  workflow?: WorkflowState;
  pr?: PrInfo | undefined;
  porcelain?: string;
  head?: string;
  unpushed?: string;
  removeExit?: number;
  terminals?: OrcaTerminalRow[];
  finished?: string[];
  trusted?: boolean;
  exists?: boolean;
  raced?: boolean;
  existsError?: boolean;
}

function setup(o: Opts = {}) {
  const calls: string[] = [];
  let stored: WorkflowState | null = o.workflow ?? wf();
  const pr: PrInfo | undefined =
    "pr" in o ? o.pr : { state: "MERGED", headRefOid: HEAD, closedAt: NOW - SETTLE_MS - 1 };
  const ports: TicketCleanupPorts = {
    workflows: async () => (stored ? [stored] : []),
    getWorkflow: async () =>
      o.raced && stored ? { ...stored, status: "pending", version: stored.version + 1 } : stored,
    clearWorkdir: async (w) => {
      calls.push("clear");
      const { workdir: _a, workspaceRef: _b, ...rest } = w;
      stored = { ...rest, version: w.version + 1 };
      return true;
    },
    prState: async () => pr,
    trusted: async () =>
      o.trusted === false ? undefined : { gitdir: "/r/.git/worktrees/x", commonDir: "/r/.git" },
    exists: async () => {
      if (o.existsError) throw new Error("EACCES");
      return o.exists !== false;
    },
    git: async (_gitdir, _wt, args) => {
      calls.push(`git ${args.join(" ")}`);
      if (args[0] === "status") return { exitCode: 0, stdout: o.porcelain ?? "" };
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${o.head ?? HEAD}\n` };
      if (args[0] === "rev-list") return { exitCode: 0, stdout: o.unpushed ?? "" };
      if (args[0] === "worktree" && args[1] === "remove")
        return { exitCode: o.removeExit ?? 0, stdout: "" };
      return { exitCode: 0, stdout: "" };
    },
    terminals: async () =>
      o.terminals ?? [{ handle: "term_a", worktreePath: WD, lastOutputAt: null }],
    closeTerminal: async (h) => {
      calls.push(`close ${h}`);
    },
    finishedTerminals: async () => new Set(o.finished ?? []),
    stopSandbox: async (t) => {
      calls.push(`stop ${t.projectId}/${t.ticketId}`);
      return 1;
    },
    forget: async () => {
      calls.push("forget");
    },
    now: () => NOW,
  };
  return {
    cleanup: new TicketCleanup(ports),
    calls,
    get stored() {
      return stored;
    },
  };
}

const destructive = (calls: string[]) =>
  calls.filter((c) => /^(close|stop|forget|clear)|worktree (remove|prune)/.test(c));

describe("ticket cleanup safety", () => {
  it("cleans a merged ticket: terminals, sandbox, worktree (no --force), prune, registries", async () => {
    const t = setup();
    const [a] = await t.cleanup.sweep();
    expect(a?.outcome).toBe("cleaned");
    expect(t.calls).toContain("close term_a");
    expect(t.calls).toContain("stop p1/NEO-7");
    expect(t.calls).toContain(`git worktree remove -- ${WD}`);
    expect(t.calls).toContain("git worktree prune");
    expect(t.calls.join(" ")).not.toMatch(/--force|-f\b|branch -[dD]/);
    expect(t.stored?.workdir).toBeUndefined();
  });

  it("is idempotent: a second sweep does nothing", async () => {
    const t = setup();
    await t.cleanup.sweep();
    const before = t.calls.length;
    expect(await t.cleanup.sweep()).toEqual([]);
    expect(t.calls.length).toBe(before);
  });

  it("leaves a merged PR on a waiting ticket to Matrix's merge step, cleans a closed one", async () => {
    const merged = setup({ workflow: wf({ status: "waiting_approval" }) });
    expect((await merged.cleanup.sweep())[0]?.outcome).toBe("kept");
    expect(destructive(merged.calls)).toEqual([]);
    const closed = setup({
      workflow: wf({ status: "waiting_approval" }),
      pr: { state: "CLOSED", headRefOid: HEAD, closedAt: 0 },
    });
    expect((await closed.cleanup.sweep())[0]?.outcome).toBe("cleaned");
  });

  it("handles a closed PR too", async () => {
    const t = setup({ pr: { state: "CLOSED", headRefOid: HEAD, closedAt: 0 } });
    expect((await t.cleanup.sweep())[0]?.outcome).toBe("cleaned");
  });

  it("never touches an open PR or a ticket without one", async () => {
    for (const pr of [{ state: "OPEN" as const, closedAt: 0 }, undefined]) {
      const t = setup({ pr });
      expect((await t.cleanup.sweep())[0]?.outcome).toBe("kept");
      expect(destructive(t.calls)).toEqual([]);
    }
  });

  it("waits for a freshly merged PR to settle", async () => {
    const t = setup({ pr: { state: "MERGED", headRefOid: HEAD, closedAt: NOW - 60_000 } });
    expect((await t.cleanup.sweep())[0]?.outcome).toBe("kept");
    expect(destructive(t.calls)).toEqual([]);
  });

  it("ignores running and pending workflows", async () => {
    for (const status of ["running", "pending"] as const) {
      const t = setup({ workflow: wf({ status }) });
      expect(await t.cleanup.sweep()).toEqual([]);
      expect(destructive(t.calls)).toEqual([]);
    }
  });

  it("skips a worktree with uncommitted changes", async () => {
    const t = setup({ porcelain: " M src/a.ts\n" });
    const [a] = await t.cleanup.sweep();
    expect(a?.outcome).toBe("skipped");
    expect(a?.reason).toMatch(/uncommitted/);
    expect(destructive(t.calls)).toEqual([]);
  });

  it("ignores .DS_Store noise", async () => {
    expect(dirtyEntries("?? .DS_Store\n?? app/.DS_Store\n")).toEqual([]);
    expect(dirtyEntries("?? .DS_Store\n?? notes.md\n")).toEqual(["?? notes.md"]);
    const t = setup({ porcelain: "?? .DS_Store\n" });
    expect((await t.cleanup.sweep())[0]?.outcome).toBe("cleaned");
  });

  it("skips unpushed commits unless HEAD is the PR head", async () => {
    const t = setup({ head: "b".repeat(40), unpushed: `${"b".repeat(40)}\n` });
    const [a] = await t.cleanup.sweep();
    expect(a?.reason).toMatch(/not on any remote/);
    expect(destructive(t.calls)).toEqual([]);
    const ok = setup({ unpushed: `${HEAD}\n` });
    expect((await ok.cleanup.sweep())[0]?.outcome).toBe("cleaned");
  });

  it("skips when a terminal printed < 10 min ago and its agent is not known finished", async () => {
    const recent = { handle: "term_b", worktreePath: WD, lastOutputAt: NOW - 60_000 };
    const t = setup({ terminals: [recent] });
    expect((await t.cleanup.sweep())[0]?.reason).toMatch(/terminal output/);
    expect(destructive(t.calls)).toEqual([]);
    const done = setup({ terminals: [recent], finished: ["term_b"] });
    expect((await done.cleanup.sweep())[0]?.outcome).toBe("cleaned");
    expect(
      terminalBusy({ ...recent, lastOutputAt: NOW - RECENT_OUTPUT_MS - 1 }, NOW, new Set()),
    ).toBe(false);
  });

  it("closes only this worktree's terminals", async () => {
    const t = setup({
      terminals: [
        { handle: "term_a", worktreePath: WD, lastOutputAt: null },
        { handle: "term_other", worktreePath: "/w/matrix-NEO-70", lastOutputAt: null },
      ],
    });
    await t.cleanup.sweep();
    expect(t.calls).toContain("close term_a");
    expect(t.calls).not.toContain("close term_other");
  });

  it("claims the workflow before destroying, keeps registries when git refuses", async () => {
    const t = setup({ removeExit: 128 });
    expect((await t.cleanup.sweep())[0]?.reason).toMatch(/refused/);
    expect(t.calls.indexOf("clear")).toBeLessThan(t.calls.indexOf("close term_a"));
    expect(t.calls).not.toContain("forget");
  });

  it("destroys nothing when the workflow moved before the claim", async () => {
    const t = setup({ raced: true });
    expect((await t.cleanup.sweep())[0]?.reason).toMatch(/changed/);
    expect(destructive(t.calls)).toEqual([]);
  });

  it("skips (never treats as absent) a worktree path it cannot stat", async () => {
    const t = setup({ existsError: true });
    expect((await t.cleanup.sweep())[0]?.outcome).toBe("skipped");
    expect(destructive(t.calls)).toEqual([]);
  });

  it("skips worktrees missing from the trusted registry", async () => {
    const t = setup({ trusted: false });
    expect((await t.cleanup.sweep())[0]?.reason).toMatch(/trusted/);
    expect(destructive(t.calls)).toEqual([]);
  });

  it("dry run lists what it would do and changes nothing", async () => {
    const t = setup();
    const [a] = await t.cleanup.sweep({ dryRun: true });
    expect(a?.outcome).toBe("would_clean");
    expect(a?.terminals).toEqual(["term_a"]);
    expect(destructive(t.calls)).toEqual([]);
  });
});

describe("ticket cleanup parsing", () => {
  it("reads Orca terminal rows and drops malformed handles", () => {
    expect(
      parseTerminalList({
        terminals: [
          { handle: "term_x-1", worktreePath: WD, lastOutputAt: 5 },
          { handle: "; rm -rf /", worktreePath: WD },
        ],
      }),
    ).toEqual([{ handle: "term_x-1", worktreePath: WD, lastOutputAt: 5 }]);
  });

  it("collects finished terminals from this worktree's evidence only", () => {
    const docs = [
      { run: { worktree: WD, coordinator: "term_c" }, terminal: "term_d" },
      { run: { worktree: "/elsewhere", coordinator: "term_e" }, terminal: "term_f" },
    ];
    expect([...finishedFromEvidence(docs, WD)]).toEqual(["term_d"]);
  });
});
