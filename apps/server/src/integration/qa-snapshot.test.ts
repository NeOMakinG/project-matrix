import { ChildProcess, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhaseContext } from "@matrix/core";
import { createHarness } from "@matrix/core/testing";
import { TrustedWorktrees, WorktreeGitPort } from "@matrix/workspace";
import { afterEach, expect, test, vi } from "vitest";
import { PrivateStateOwner } from "../state-owner.js";
import { committedQaSnapshot } from "./qa-snapshot.js";

const fake = vi.hoisted(() => ({
  tree: "",
  blobs: new Map<string, Buffer>(),
  read: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:child_process", async (load) => {
  const original = await load<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return {
    ...original,
    execFile: Object.assign(
      () => {
        throw new Error("unexpected execution in mock Git fixture");
      },
      {
        [promisify.custom]: async (binary: string, args: string[]) => {
          if (binary !== "git") throw new Error("unexpected binary");
          if (args.includes("ls-tree"))
            return { stdout: Buffer.from(fake.tree), stderr: Buffer.alloc(0) };
          if (args.includes("cat-file")) {
            await fake.read?.();
            const blob = fake.blobs.get(args.at(-1)!);
            if (!blob) throw new Error("unknown fixture blob");
            return { stdout: blob, stderr: Buffer.alloc(0) };
          }
          throw new Error("unexpected Git read");
        },
      },
    ),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  fake.blobs.clear();
  fake.read = undefined;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "matrix-qa-snapshot-"));
  const workdir = join(root, "worktree");
  await mkdir(workdir);
  await writeFile(join(workdir, "untrusted.txt"), "must not copy working tree contents");
  const harness = createHarness();
  const ticket = harness.tickets.add("test");
  const scratch: string[] = [];
  const context: PhaseContext = {
    project: harness.project,
    workflow: {
      projectId: "test",
      ticketId: ticket.id,
      phase: "qa",
      status: "running",
      attempt: 0,
      loops: 0,
      priority: 1,
      version: 1,
    },
    ticket,
    tickets: harness.tickets,
    workdir,
    runId: "test",
    branch: "matrix/test",
    idempotencyKey: "test",
    signal: new AbortController().signal,
    emit: () => {},
    stillOwner: async () => true,
    authorize: async () => ({ ok: false, kind: "gates", reason: "not used" }),
    scratchDir: async () => {
      const dir = await mkdtemp(join(root, "scratch-"));
      scratch.push(dir);
      return dir;
    },
  };
  const trusted = new TrustedWorktrees(join(root, "registry.json"));
  vi.spyOn(trusted, "lookup").mockResolvedValue({
    gitdir: join(root, "host-owned-git"),
    commonDir: join(root, "host-owned-git"),
  });
  const git = new WorktreeGitPort({ trusted });
  vi.spyOn(git, "cleanForChecks").mockResolvedValue("a".repeat(40));
  fake.tree = `100644 blob ${"b".repeat(40)}      26\tsrc/add.ts\0`;
  fake.blobs.set("b".repeat(40), Buffer.from("export const answer = 42;\n"));
  return { root, context, git, trusted, scratch };
}

test("snapshot materializes only committed blobs, preserves binary bytes and excludes git metadata (mock Git)", async () => {
  const setup = await fixture();
  try {
    const bytes = Buffer.from([0, 255, 13, 10]);
    fake.tree += `100644 blob ${"c".repeat(40)}       4\tassets/image.dat\0`;
    fake.blobs.set("c".repeat(40), bytes);
    const snapshot = await committedQaSnapshot(setup.context, setup.git, setup.trusted);
    expect(snapshot.headSha).toBe("a".repeat(40));
    expect(await readFile(join(snapshot.directory, "src/add.ts"), "utf8")).toBe(
      "export const answer = 42;\n",
    );
    expect(await readFile(join(snapshot.directory, "assets/image.dat"))).toEqual(bytes);
    expect((await readdir(snapshot.directory)).sort()).toEqual(["assets", "src"]);
    const next = await setup.context.scratchDir();
    snapshot.materialize(next);
    expect(await readFile(join(next, "assets/image.dat"))).toEqual(bytes);
    expect(() => snapshot.materialize(setup.context.workdir)).toThrow("outside and not contain");
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test.each(["symlink", "traversal", "git metadata"])(
  "snapshot refuses %s before publication (mock Git)",
  async (kind) => {
    const setup = await fixture();
    try {
      const path =
        kind === "traversal" ? "../outside" : kind === "git metadata" ? ".git/config" : "src/link";
      fake.tree = `${kind === "symlink" ? "120000" : "100644"} blob ${"b".repeat(40)} 26\t${path}\0`;
      await expect(committedQaSnapshot(setup.context, setup.git, setup.trusted)).rejects.toThrow(
        "unsafe paths or non-regular",
      );
      expect(setup.scratch).toEqual([]);
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  },
);

test("guardian-only replacement during a committed blob read prevents snapshot publication (mock Git, real guardian)", async () => {
  const setup = await fixture();
  const owner = new PrivateStateOwner(join(setup.root, "private"));
  let replacement: PrivateStateOwner | undefined;
  let resume = () => {};
  let reading = () => {};
  const entered = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  fake.read = async () => {
    reading();
    await wait;
  };
  try {
    const pending = committedQaSnapshot(setup.context, setup.git, setup.trusted, owner);
    const rejected = expect(pending).rejects.toThrow("ownership lost");
    await entered;
    const guardian: unknown = Reflect.get(owner, "child");
    if (!(guardian instanceof ChildProcess)) throw new Error("missing guardian");
    expect(guardian.kill("SIGKILL")).toBe(true);
    spawnSync("sleep", ["0.05"]);
    replacement = new PrivateStateOwner(join(setup.root, "private"));
    resume();
    await rejected;
    expect(setup.scratch).toEqual([]);
    expect(await readdir(setup.context.workdir)).toEqual(["untrusted.txt"]);
  } finally {
    resume();
    await owner.close();
    await replacement?.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("large and binary committed assets become empty placeholders and are never read (mock Git)", async () => {
  const setup = await fixture();
  try {
    // A 49 MB model (NEO-8) used to overflow the 16 MB read buffer and fail QA preparation.
    fake.tree += `100644 blob ${"d".repeat(40)} 49634121\tapp/assets/model.onnx\0`;
    fake.tree += `100644 blob ${"e".repeat(40)}     2048\tapp/assets/icon.png\0`;
    fake.tree += `100644 blob ${"f".repeat(40)}  5000000\tapp/data/huge.json\0`;
    const snapshot = await committedQaSnapshot(setup.context, setup.git, setup.trusted);
    expect(snapshot.placeholders).toBe(3);
    expect(snapshot.placeholderPaths).toEqual([
      "app/assets/model.onnx",
      "app/assets/icon.png",
      "app/data/huge.json",
    ]);
    for (const path of ["app/assets/model.onnx", "app/assets/icon.png", "app/data/huge.json"])
      expect((await readFile(join(snapshot.directory, path))).length).toBe(0);
    expect(await readFile(join(snapshot.directory, "src/add.ts"), "utf8")).toBe(
      "export const answer = 42;\n",
    );
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("a failed committed read names a bounded reason (mock Git)", async () => {
  const setup = await fixture();
  try {
    fake.tree += `100644 blob ${"9".repeat(40)}       10\tsrc/missing.ts\0`;
    await expect(committedQaSnapshot(setup.context, setup.git, setup.trusted)).rejects.toThrow(
      "QA committed snapshot cat-file failed (git unavailable)",
    );
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});
