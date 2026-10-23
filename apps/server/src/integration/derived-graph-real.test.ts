import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGraphDrift, graphArtifacts, writeGraph } from "@matrix/graph";
import { NativeWorkspace, WorktreeGitPort } from "@matrix/workspace";
import { expect, test } from "vitest";
import { derivedGraphHandover } from "./derived-graph.js";

test.each([
  "body-only",
  "graph-shape",
  "forged-json",
  "forged-markdown",
  "scan-failure",
  "scan-cancel",
])(
  "real native graph handover: %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "matrix-real-graph-"));
    const repo = join(root, "repo");
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args],
        { encoding: "utf8" },
      ).trim();
    try {
      await mkdir(join(repo, "src"), { recursive: true });
      await mkdir(join(repo, "test"));
      await mkdir(join(repo, "docs/adr"), { recursive: true });
      await writeFile(join(repo, "CONTEXT.md"), "Harmless tiny addition fixture.\n");
      await writeFile(
        join(repo, "docs/adr/0001-pure.md"),
        "# Pure addition\n\nAddition has no side effects.\n",
      );
      await writeFile(
        join(repo, "src/add.ts"),
        "export function add(left: number, right: number): number { return 0; }\n",
      );
      await writeFile(
        join(repo, "test/add.test.ts"),
        'import { add } from "../src/add";\nimport { expect, test } from "bun:test";\ntest("add", () => expect(add(1, 2)).toBe(3));\n',
      );
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({ type: "module", scripts: { test: "bun test" } }),
      );
      await writeFile(join(repo, ".gitignore"), "node_modules/\ndist/\n");
      const base = await writeGraph(repo);
      git("init", "-q", "-b", "main");
      git("add", ".");
      git("commit", "-qm", "fixture");
      const workspace = new NativeWorkspace({ root: join(root, "worktrees") });
      const prepared = await workspace.prepare({
        projectId: "qa",
        ticketId: "tiny",
        repoPath: repo,
        baseBranch: "main",
        branch: "matrix/tiny",
      });
      const port = new WorktreeGitPort({ trusted: workspace.trusted });
      const head = await port.headSha(prepared.workdir);
      expect((await graphArtifacts(prepared.workdir)).files).toEqual(base.files);
      await writeFile(
        join(prepared.workdir, "src/add.ts"),
        "export function add(left: number, right: number): number { return left + right; }\n",
      );
      if (mode === "graph-shape")
        await writeFile(join(prepared.workdir, "src/new.ts"), 'export { add } from "./add";\n');
      const forged = mode === "forged-json" ? ".matrix/graph/code.json" : ".matrix/graph/GRAPH.md";
      if (mode.startsWith("forged"))
        await writeFile(join(prepared.workdir, forged), "agent forgery\n");
      const abort = new AbortController();
      let scans = 0;
      const pending = port.commitImplementation(prepared.workdir, {
        expectedHead: head,
        approvedPaths: ["src"],
        message: "fixture implementation",
        signal: abort.signal,
        derivedGraph: derivedGraphHandover(prepared.workdir, abort.signal),
        scan: async (source, binding) => {
          scans++;
          expect(await readFile(join(source, "src/add.ts"), "utf8")).toContain("left + right");
          // The snapshot holds only blobs changed since BASE (graph files only when they changed).
          expect(binding.objects.map((object) => object.path)).toContain("src/add.ts");
          if (mode === "scan-cancel") abort.abort(new Error("fixture ownership cancellation"));
          return {
            kind: "secret-scan",
            ok: mode !== "scan-failure",
            summary: "FAKE scanner only",
            data: binding,
          };
        },
      });
      if (mode.startsWith("forged") || mode.startsWith("scan-")) {
        await expect(pending).rejects.toThrow(
          mode.startsWith("forged")
            ? "unapproved implementation path"
            : mode === "scan-failure"
              ? "secret scan failed closed"
              : "fixture ownership cancellation",
        );
        expect(scans).toBe(mode.startsWith("forged") ? 0 : 1);
        expect(await port.headSha(prepared.workdir)).toBe(head);
        for (const [path, content] of Object.entries(base.files))
          expect(await readFile(join(prepared.workdir, path), "utf8")).toBe(
            mode.startsWith("forged") && path === forged ? "agent forgery\n" : content,
          );
        return;
      }
      const committed = await pending;
      expect(committed.headSha).not.toBe(head);
      expect(await port.cleanForChecks(prepared.workdir)).toBe(committed.headSha);
      expect(await checkGraphDrift(prepared.workdir)).toEqual({ ok: true, stale: [] });
      execFileSync("bun", ["test"], { cwd: prepared.workdir, stdio: "pipe" });
      expect(await port.cleanForChecks(prepared.workdir)).toBe(committed.headSha);
      expect(git("rev-parse", "main")).toBe(head);
      expect(committed.receipt.data).toEqual(
        expect.objectContaining({
          headSha: committed.headSha,
          tree: git("rev-parse", `${committed.headSha}^{tree}`),
        }),
      );
      const fresh = await graphArtifacts(prepared.workdir);
      for (const [path, content] of Object.entries(fresh.files)) {
        expect(
          execFileSync("git", ["-C", repo, "show", `${committed.headSha}:${path}`], {
            encoding: "utf8",
          }),
        ).toBe(content);
        expect(content).not.toContain(root);
      }
      expect(fresh.files).toEqual((await graphArtifacts(prepared.workdir)).files);
      if (mode === "graph-shape") expect(fresh.files).not.toEqual(base.files);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
