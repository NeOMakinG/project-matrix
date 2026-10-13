import { ChildProcess, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as graph from "@matrix/graph";
import { checkGraphDrift, graphArtifacts } from "@matrix/graph";
import type { LineExecutor } from "@matrix/sandbox";
import { TrustedWorktrees, WorktreeGitPort } from "@matrix/workspace";
import { afterEach, expect, test, vi } from "vitest";
import { PrivateStateOwner } from "../state-owner.js";
import { derivedGraphHandover } from "./derived-graph.js";

const fake = vi.hoisted(() => ({ blobs: new Map<string, Buffer>() }));
vi.mock("node:child_process", async (load) => {
  const original = await load<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return {
    ...original,
    spawnSync: vi.fn((command, ...args) =>
      command === "git"
        ? { status: 1, stdout: "", stderr: "", signal: null, pid: 0, output: [] }
        : original.spawnSync(command, ...args),
    ),
    execFile: Object.assign(
      vi.fn(() => {
        throw new Error("raw command execution forbidden in mocked Git fixture");
      }),
      {
        [promisify.custom]: async (binary: string, args: string[]) => {
          if (binary !== "git" || !args.includes("cat-file"))
            throw new Error("unexpected fixture command");
          const stdout = fake.blobs.get(args.at(-1)!);
          if (!stdout) throw new Error("unknown mock blob");
          return { stdout, stderr: "" };
        },
      },
    ),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  fake.blobs.clear();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "matrix-derived-graph-"));
  const workdir = join(root, "worktree");
  const gitdir = join(root, "metadata", "worktrees", "ticket");
  await mkdir(gitdir, { recursive: true });
  await mkdir(join(workdir, "src"), { recursive: true });
  await writeFile(join(workdir, ".git"), `gitdir: ${gitdir}\n`);
  await writeFile(join(workdir, "src/add.ts"), "export const add = 0;\n");
  const baseGraph = (await graphArtifacts(workdir)).files;
  for (const [path, content] of Object.entries(baseGraph)) {
    await mkdir(dirname(join(workdir, path)), { recursive: true });
    await writeFile(join(workdir, path), content);
  }
  const paths = ["src/add.ts", ...Object.keys(baseGraph)];
  const read = async (directory: string) =>
    new Map(
      await Promise.all(
        paths.map(async (path) => [path, await readFile(join(directory, path))] as const),
      ),
    );
  const base = await read(workdir);
  const baseHead = "a".repeat(40);
  const baseTree = "b".repeat(40);
  const committedHead = "c".repeat(40);
  let head = baseHead;
  let candidateTree = "";
  let index = new Map<string, Buffer>();
  let refWrites = 0;
  const blobSha = (content: Buffer) =>
    createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
  const records = () =>
    [...index].map(([path, content]) => `100644 blob ${blobSha(content)}\t${path}\0`).join("");
  const status = async (nul: boolean) =>
    (
      await Promise.all(
        paths.map(async (path) => {
          const content = await readFile(join(workdir, path));
          const expected = head === baseHead ? base.get(path) : index.get(path);
          return content.equals(expected!) ? "" : ` M ${path}${nul ? "\0" : "\n"}`;
        }),
      )
    ).join("");
  const executor: LineExecutor = async (spec, emit, signal) => {
    signal.throwIfAborted();
    const args = spec.cmd;
    let stdout = "";
    let exitCode = 0;
    if (args.includes("read-tree") && spec.env.GIT_INDEX_FILE) index = new Map(base);
    else if (args.includes("add")) {
      const staging = args[args.indexOf("--work-tree") + 1]!;
      for (const path of args.slice(args.indexOf("--") + 1))
        index.set(path, await readFile(join(staging, path)));
    } else if (args.includes("write-tree")) {
      candidateTree = createHash("sha1").update(records()).digest("hex");
      for (const content of index.values()) fake.blobs.set(blobSha(content), content);
      stdout = candidateTree;
    } else if (args.includes("ls-tree")) {
      if (args.at(-1) === candidateTree) stdout = records();
    } else if (args.includes("ls-files")) {
      if (args.includes("--stage"))
        stdout = [...(spec.env.GIT_INDEX_FILE ? index : base)]
          .map(([path, content]) => `100644 ${blobSha(content)} 0\t${path}\0`)
          .join("");
      else if (args.includes("--cached")) stdout = `${paths.join("\0")}\0`;
    } else if (args.includes("status")) stdout = await status(args.includes("-z"));
    else if (args.includes("symbolic-ref")) stdout = "refs/heads/matrix/ticket";
    else if (args.includes("rev-parse")) stdout = baseTree;
    else if (args.includes("diff-files")) {
      const actual = await read(workdir);
      if ([...index].some(([path, content]) => !content.equals(actual.get(path)!))) exitCode = 1;
    } else if (args.includes("commit-tree")) stdout = committedHead;
    else if (args.includes("update-ref")) {
      head = committedHead;
      refWrites++;
    }
    if (stdout) emit(stdout);
    return { exitCode, timedOut: false, cancelled: false, stderrTail: "" };
  };
  const trusted = new TrustedWorktrees();
  await trusted.record(workdir, { gitdir, commonDir: join(root, "metadata"), baseSha: baseHead });
  const git = new WorktreeGitPort({ trusted, executor });
  vi.spyOn(git, "headSha").mockImplementation(async () => head);
  vi.spyOn(git, "treeState").mockImplementation(async () => {
    const hash = createHash("sha256").update(head);
    for (const [path, content] of await read(workdir)) hash.update(path).update(content);
    return hash.digest("hex");
  });
  vi.spyOn(git, "isClean").mockImplementation(async () => (await status(false)) === "");
  await writeFile(
    join(workdir, "src/add.ts"),
    "export const add = 2;\nexport const addedByImplementation = true;\n",
  );
  return { root, workdir, git, baseHead, committedHead, baseGraph, refWrites: () => refWrites };
}

test("mocked Git handover scans fresh graph in the final candidate and checks bind to committed SHA", async () => {
  const setup = await fixture();
  try {
    expect((await checkGraphDrift(setup.workdir)).ok).toBe(false);
    let scanned = false;
    const result = await setup.git.commitImplementation(setup.workdir, {
      expectedHead: setup.baseHead,
      approvedPaths: ["src"],
      message: "mocked Git fixture, not real native QA",
      derivedGraph: derivedGraphHandover(setup.workdir, new AbortController().signal),
      scan: async (source, binding) => {
        expect(await checkGraphDrift(source)).toEqual({ ok: true, stale: [] });
        expect(binding.objects.map((object) => object.path)).toEqual(
          expect.arrayContaining(Object.keys(setup.baseGraph)),
        );
        for (const path of Object.keys(setup.baseGraph))
          expect(await readFile(join(setup.workdir, path), "utf8")).toBe(setup.baseGraph[path]);
        scanned = true;
        return {
          kind: "secret-scan",
          ok: true,
          summary: "FAKE scanner; real candidate bytes inspected",
        };
      },
    });
    expect(scanned).toBe(true);
    expect(result.headSha).toBe(setup.committedHead);
    expect(await setup.git.cleanForChecks(setup.workdir)).toBe(result.headSha);
    expect(await checkGraphDrift(setup.workdir)).toEqual({ ok: true, stale: [] });
    expect(setup.refWrites()).toBe(1);
    expect(result.receipt.data).toMatchObject({ headSha: result.headSha });
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test.each([".matrix/graph/code.json", ".matrix/graph/GRAPH.md"])(
  "agent-forged %s is rejected before generation, scanning or committing",
  async (path) => {
    const setup = await fixture();
    try {
      await writeFile(join(setup.workdir, path), "forged graph");
      const derived = derivedGraphHandover(setup.workdir, new AbortController().signal);
      const generate = vi.spyOn(derived, "generate");
      const scan = vi.fn();
      await expect(
        setup.git.commitImplementation(setup.workdir, {
          expectedHead: setup.baseHead,
          approvedPaths: ["src"],
          message: "fixture",
          derivedGraph: derived,
          scan,
        }),
      ).rejects.toThrow(`unapproved implementation path: ${path}`);
      expect(generate).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(setup.refWrites()).toBe(0);
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  },
);

test("guardian-only loss during graph generation cannot publish after a replacement owner acquires", async () => {
  const setup = await fixture();
  const owner = new PrivateStateOwner(setup.root);
  let next: PrivateStateOwner | undefined;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const pause = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const original = graph.graphArtifacts;
  vi.spyOn(graph, "graphArtifacts").mockImplementationOnce(async (root) => {
    const result = await original(root);
    entered();
    await pause;
    return result;
  });
  try {
    const pending = setup.git.commitImplementation(setup.workdir, {
      expectedHead: setup.baseHead,
      approvedPaths: ["src"],
      message: "mocked Git ownership fixture",
      derivedGraph: derivedGraphHandover(setup.workdir, new AbortController().signal, owner),
      scan: async () => ({
        kind: "secret-scan",
        ok: true,
        summary: "FAKE scanner, must not publish",
      }),
    });
    const rejected = expect(pending).rejects.toThrow("ownership lost");
    await waiting;
    const child: unknown = Reflect.get(owner, "child");
    if (!(child instanceof ChildProcess)) throw new Error("missing ownership guardian");
    expect(child.kill("SIGKILL")).toBe(true);
    spawnSync("sleep", ["0.05"]);
    next = new PrivateStateOwner(setup.root);
    resume();
    await rejected;
    for (const [path, content] of Object.entries(setup.baseGraph))
      expect(await readFile(join(setup.workdir, path), "utf8")).toBe(content);
    expect(setup.refWrites()).toBe(0);
  } finally {
    resume();
    await owner.close();
    await next?.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("failed scan or ownership cancellation cannot publish derived files or commit", async () => {
  for (const reason of ["scan", "abort"]) {
    const setup = await fixture();
    const abort = new AbortController();
    try {
      await expect(
        setup.git.commitImplementation(setup.workdir, {
          expectedHead: setup.baseHead,
          approvedPaths: ["src"],
          message: "fixture",
          signal: abort.signal,
          derivedGraph: derivedGraphHandover(setup.workdir, abort.signal),
          scan: async () => {
            if (reason === "abort") abort.abort(new Error("ownership cancellation fixture"));
            return { kind: "secret-scan", ok: reason !== "scan", summary: "FAKE scan fixture" };
          },
        }),
      ).rejects.toThrow(
        reason === "scan" ? "secret scan failed closed" : "ownership cancellation fixture",
      );
      for (const [path, content] of Object.entries(setup.baseGraph))
        expect(await readFile(join(setup.workdir, path), "utf8")).toBe(content);
      expect(setup.refWrites()).toBe(0);
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  }
});
