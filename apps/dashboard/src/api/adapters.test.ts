import { describe, expect, it } from "vitest";
import { adrs, graph, receiptsByRun, runs, tickets } from "@/mocks/data/server";
import {
  adaptAdrs,
  adaptGraph,
  adaptReceipts,
  adaptRun,
  adaptTickets,
  phaseStates,
  runStatus,
  ticketKind,
  ticketPhase,
} from "./adapters";

describe("adapters", () => {
  it("derives ticket kind from labels and phase from phase or status", () => {
    expect(ticketKind(["billing", "Bug"])).toBe("bug");
    expect(ticketKind(["incident"])).toBe("prod-fix");
    expect(ticketKind([])).toBe("feature");
    expect(ticketPhase({ phase: "qa", status: "open" })).toBe("qa");
    expect(ticketPhase({ phase: "compound", status: "review" })).toBe("review");
    expect(ticketPhase({ status: "closed" })).toBeNull();
  });

  it("links tickets to their latest run", () => {
    const view = adaptTickets(tickets, runs);
    expect(view.find((t) => t.id === "MX-142")?.runId).toBe("r_8f3a2c");
    expect(view.find((t) => t.id === "MX-156")?.runId).toBeNull();
  });

  it("maps run states and phase progress", () => {
    expect(runStatus("running")).toBe("running");
    expect(runStatus("paused")).toBe("paused");
    expect(runStatus("failed")).toBe("failed");
    expect(runStatus("done")).toBe("done");
    expect(phaseStates("qa", "running").map((p) => p.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "active",
      "pending",
      "pending",
      "pending",
    ]);
    expect(phaseStates("review", "failed")[3]?.state).toBe("failed");
  });

  it("splits receipts and drops links that are not https on an allowed host", () => {
    const { findings, qa, holdout } = adaptReceipts(receiptsByRun.r_8f3a2c ?? []);
    expect(findings.map((f) => f.severity)).toEqual(["P2", "P3", "P3"]);
    expect(holdout?.satisfied).toBe(11);
    expect(qa.find((r) => r.label === "plans.png")?.url).toMatch(/^https:\/\/github\.com\//);
    expect(qa.find((r) => r.label === "checkout.png")?.url).toBeNull();
  });

  it("rejects unsafe workspace links and malformed commits", () => {
    const bad = runs.find((r) => r.id === "r_bad");
    const good = runs.find((r) => r.id === "r_8f3a2c");
    if (!bad || !good) throw new Error("fixtures");
    expect(adaptRun(bad, [], {}).workspaceUrl).toBeNull();
    expect(adaptRun(good, [], {}).workspaceUrl).toBe("orca://worktree/bosgame/pilot-142");
    expect(adaptRun({ ...good, headSha: "zzz; rm -rf" }, [], {}).headSha).toBeNull();
  });

  it("drops graph edges to unknown nodes and colours ADRs by check results", () => {
    const g = adaptGraph(graph);
    expect(g.edges.some((e) => e.target === "missing-node")).toBe(false);
    const view = adaptAdrs(adrs, new Map([["0011", { errors: 1, warnings: 0 }]]));
    expect(view.find((a) => a.id === "0011")?.status).toEqual({
      label: "1 violation",
      tone: "red",
    });
    expect(view.find((a) => a.id === "0007")?.status.label).toBe("passing");
    expect(view.find((a) => a.id === "0014")?.status.label).toBe("proposed");
  });
});
