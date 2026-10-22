import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LineExecutor } from "@matrix/sandbox";
import { describe, expect, test } from "vitest";
import { ticketStoreContract } from "../testing/contract";
import { BeadsStore } from "./beads";
import { GitHubStore, joinBody, splitBody } from "./github";
import { MemoryStore } from "./memory";

/** Minimal in-memory `gh` simulator covering the commands GitHubStore uses. */
function fakeGh(): LineExecutor {
  interface Issue {
    number: number;
    title: string;
    body: string;
    state: string;
    labels: Array<{ name: string }>;
    assignees: Array<{ login: string }>;
    createdAt: string;
    updatedAt: string;
    url: string;
  }
  const issues = new Map<number, Issue>();
  let seq = 0;
  const flagValues = (args: string[], flag: string) =>
    args.flatMap((a, i) =>
      a === flag && args[i + 1] !== undefined ? [args[i + 1] as string] : [],
    );
  return async (spec, onLine) => {
    const r = spec.cmd.indexOf("-R");
    const args = [...spec.cmd.slice(1, r), ...spec.cmd.slice(r + 2)].filter((a) => a !== "--");
    const [group, action, id] = args;
    const now = new Date().toISOString();
    const ok = (out = "") => {
      for (const line of out.split("\n")) if (line) onLine(line);
      return { exitCode: 0, timedOut: false, cancelled: false, stderrTail: "" };
    };
    if (group === "label") return ok();
    if (group !== "issue") throw new Error(`unsupported gh ${group}`);
    const issue = id ? issues.get(Number(id)) : undefined;
    switch (action) {
      case "create": {
        seq += 1;
        issues.set(seq, {
          number: seq,
          title: flagValues(args, "--title")[0] ?? "",
          body: spec.stdin ?? "",
          state: "OPEN",
          labels: flagValues(args, "--label").map((name) => ({ name })),
          assignees: [],
          createdAt: now,
          updatedAt: now,
          url: `https://github.com/o/r/issues/${seq}`,
        });
        return ok(`https://github.com/o/r/issues/${seq}`);
      }
      case "view":
        if (!issue)
          return { exitCode: 1, timedOut: false, cancelled: false, stderrTail: "issue not found" };
        return ok(JSON.stringify(issue));
      case "list":
        return ok(JSON.stringify([...issues.values()]));
      case "edit": {
        if (!issue)
          return { exitCode: 1, timedOut: false, cancelled: false, stderrTail: "issue not found" };
        if (spec.stdin !== undefined) issue.body = spec.stdin;
        const title = flagValues(args, "--title")[0];
        if (title) issue.title = title;
        const remove = new Set(flagValues(args, "--remove-label"));
        issue.labels = [
          ...issue.labels.filter((l) => !remove.has(l.name)),
          ...flagValues(args, "--add-label").map((name) => ({ name })),
        ];
        issue.updatedAt = now;
        return ok();
      }
      case "close":
      case "reopen":
        if (issue) issue.state = action === "close" ? "CLOSED" : "OPEN";
        return ok();
      case "comment":
        return ok();
      default:
        throw new Error(`unsupported gh issue ${action}`);
    }
  };
}

const hasBd = (() => {
  try {
    execFileSync("bd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function beadsRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "matrix-beads-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("bd", ["init", "--quiet", "--prefix", "mt"], { cwd: dir, stdio: "ignore" });
  return dir;
}

ticketStoreContract("memory", async () => new MemoryStore());
ticketStoreContract(
  "github (fake gh)",
  async () => new GitHubStore({ repo: "o/r", executor: fakeGh() }),
);
describe.runIf(hasBd)("beads (real bd)", () => {
  ticketStoreContract("beads", async () => new BeadsStore({ cwd: await beadsRepo() }), 120_000);
});

describe("github body metadata", () => {
  test("round-trips and hides matrix fields", () => {
    const body = joinBody("Hello\n\nWorld", { status: "qa", deps: ["3"] });
    expect(body).toContain("<!-- matrix:");
    expect(splitBody(body)).toEqual({
      text: "Hello\n\nWorld",
      meta: { status: "qa", deps: ["3"] },
    });
    expect(splitBody("plain")).toEqual({ text: "plain", meta: {} });
    expect(joinBody("x", {})).toBe("x");
  });

  test("rejects malformed repo names", () => {
    expect(() => new GitHubStore({ repo: "o/r; rm -rf" })).toThrow();
  });
});

describe("github labels", () => {
  test("addLabel / removeLabel toggle one label", async () => {
    const store = new GitHubStore({ repo: "o/r", executor: fakeGh() });
    const t = await store.create({ title: "T", body: "b", labels: ["bug"] });
    await store.addLabel(t.id, "needs-human");
    expect((await store.get(t.id))?.labels).toEqual(["bug", "needs-human"]);
    await store.removeLabel(t.id, "needs-human");
    await store.removeLabel(t.id, "needs-human");
    expect((await store.get(t.id))?.labels).toEqual(["bug"]);
  });
});
