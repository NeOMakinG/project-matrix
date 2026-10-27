import { describe, expect, test } from "vitest";
import type { OrcaCaller } from "./deploy-orca.js";
import { reapRouteWorktrees } from "./orca-reaper.js";

const NOW = 10_000_000_000;
const MIN = 60_000;

function fake(worktrees: object[]) {
  const calls: string[][] = [];
  const cli: OrcaCaller = {
    async call(args) {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") return { worktrees };
      return {};
    },
  };
  return { cli, calls };
}

describe("orca route reaper", () => {
  test("removes old route worktrees with no live run; keeps young, live and foreign ones", async () => {
    const w = (path: string, ageMin: number, extra: object = {}) => ({
      path,
      displayName: path.split("/").at(-1),
      createdAt: NOW - ageMin * MIN,
      ...extra,
    });
    const f = fake([
      w("/ws/wayline/mx-run-91c13da1-cfa872", 45),
      w("/ws/wayline/mx-run-eb3e9d3d-7a31be", 10),
      w("/ws/aicompany/mx-deploy-7459602e-a1b2c3", 90),
      w("/ws/wayline/feature-login", 900),
      w("/ws/wayline/mx-notes", 900),
      w("/ws/wayline", 900, { isMainWorktree: true }),
    ]);
    const r = await reapRouteWorktrees({
      routes: [{ environment: "macbook-pro", repos: { "o/r": "/x/aicompany" } }],
      cli: () => f.cli,
      now: () => NOW,
      live: new Set(["/ws/aicompany/mx-deploy-7459602e-a1b2c3"]),
    });
    expect(r.removed).toEqual(["macbook-pro:/ws/wayline/mx-run-91c13da1-cfa872"]);
    expect(r.kept).toBe(2);
    const rm = f.calls.filter((c) => c[1] === "rm").map((c) => c[3]);
    expect(rm).toEqual(["path:/ws/wayline/mx-run-91c13da1-cfa872"]);
    // terminals are stopped before the worktree goes
    const i = f.calls.findIndex((c) => c[0] === "terminal" && c[1] === "close");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(f.calls.findIndex((c) => c[1] === "rm"));
  });

  test("one environment failing to list does not stop the others", async () => {
    const bad: OrcaCaller = {
      call: async () => {
        throw new Error("unreachable");
      },
    };
    const good = fake([{ path: "/w/r/mx-run-aaaaaaaa-abcdef", createdAt: NOW - 60 * MIN }]);
    const r = await reapRouteWorktrees({
      routes: [
        { environment: "a", repos: { "o/r": "/r" } },
        { environment: "b", repos: { "o/r": "/r" } },
      ],
      cli: (env) => (env === "a" ? bad : good.cli),
      now: () => NOW,
      live: new Set(),
    });
    expect(r.errors[0]).toContain("a: worktree list failed");
    expect(r.removed).toEqual(["b:/w/r/mx-run-aaaaaaaa-abcdef"]);
  });
});
