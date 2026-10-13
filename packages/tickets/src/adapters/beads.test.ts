import type { LineExecutor } from "@matrix/sandbox";
import { describe, expect, test } from "vitest";
import { BeadsStore } from "./beads.js";
import { BeadsQueueTimeoutError, withBeadsQueue } from "./beads-queue.js";

const issue = {
  id: "mt-1",
  title: "Ticket",
  status: "open",
  labels: [],
  created_at: "2026-10-13",
  updated_at: "2026-10-13",
  dependency_count: 1,
  dependencies: [{ id: "mt-2", dependency_type: "blocks" }],
};
const outcome = { exitCode: 0, timedOut: false, cancelled: false, stderrTail: "" };

describe("beads command budget", () => {
  test("list, ready, create and update use returned issues without follow-up shows", async () => {
    const calls: string[][] = [];
    const executor: LineExecutor = async (spec, onLine) => {
      calls.push(spec.cmd);
      const command = spec.cmd[1];
      if (command === "show") throw new Error("unexpected N+1 show");
      onLine(JSON.stringify(command === "create" ? issue : [issue]));
      return outcome;
    };
    const store = new BeadsStore({ cwd: "/tmp/beads-count", executor });
    expect((await store.list())[0]?.deps).toEqual(["mt-2"]);
    expect((await store.ready())[0]?.deps).toEqual(["mt-2"]);
    await store.create({ title: "Ticket", body: "Body" });
    await store.update("mt-1", { status: "qa" });
    await store.update("mt-1", { deps: ["mt-2", "mt-3"] });
    expect(calls.map((args) => args[1])).toEqual(["list", "ready", "create", "update", "dep"]);
    expect(calls[3]).toContain("--json");
  });

  test("an uncached scalar update uses update JSON without show", async () => {
    const calls: string[] = [];
    const executor: LineExecutor = async (spec, onLine) => {
      calls.push(spec.cmd[1]!);
      onLine(JSON.stringify(issue));
      return outcome;
    };
    const store = new BeadsStore({ cwd: "/tmp/beads-uncached", executor });
    await store.update("mt-1", { title: "Changed" });
    expect(calls).toEqual(["update"]);
  });

  test("adapter instances serialize the same repository, not different repositories", async () => {
    let active = 0;
    let maximum = 0;
    const executor: LineExecutor = async (_spec, onLine) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      onLine(JSON.stringify([issue]));
      return outcome;
    };
    const first = new BeadsStore({ cwd: "/tmp/beads-serial", executor });
    const second = new BeadsStore({ cwd: "/tmp/beads-serial/../beads-serial", executor });
    await Promise.all([first.list(), second.ready(), first.update("mt-1", { title: "new" })]);
    expect(maximum).toBe(1);
    maximum = 0;
    const other = new BeadsStore({ cwd: "/tmp/beads-other", executor });
    await Promise.all([first.list(), other.list()]);
    expect(maximum).toBe(2);
  });

  test("bounded queue waits skip expired work and do not release an occupied repository", async () => {
    let release = () => {};
    const blocker = withBeadsQueue(
      "/tmp/beads-timeout",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    let executed = false;
    await expect(
      withBeadsQueue(
        "/tmp/beads-timeout",
        async () => {
          executed = true;
        },
        undefined,
        5,
      ),
    ).rejects.toBeInstanceOf(BeadsQueueTimeoutError);
    let started = false;
    const next = withBeadsQueue("/tmp/beads-timeout", async () => {
      started = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(false);
    release();
    await Promise.all([blocker, next]);
    expect(executed).toBe(false);
    expect(started).toBe(true);
  });

  test("execution deadline begins after queue acquisition and failures release the slot", async () => {
    const cwd = "/tmp/beads-execution";
    const blocker = withBeadsQueue(cwd, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const executor: LineExecutor = async (_spec, onLine) => {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 5)),
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("execution timeout")), 15);
          timer.unref();
        }),
      ]);
      onLine(JSON.stringify([issue]));
      return outcome;
    };
    const store = new BeadsStore({ cwd, executor });
    expect(await store.list()).toHaveLength(1);
    await blocker;
    await expect(
      withBeadsQueue(cwd, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(await store.list()).toHaveLength(1);
  });
});
