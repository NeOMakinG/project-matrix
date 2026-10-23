import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostExecutor } from "@matrix/sandbox";
import { describe, expect, test } from "vitest";
import { scanSourceSnapshot } from "../../../apps/server/src/integration/source-scan.js";
import { SOURCE_READ_LIMIT, WorktreeGitPort } from "./git-port.js";
import { NativeWorkspace } from "./native.js";

async function fixture(policy?: {
  ignore?: string;
  attributes?: string;
  config?: string;
  packageRoots?: string[];
  branch?: string;
  largeFile?: string;
}) {
  const repo = await mkdtemp(join(tmpdir(), "matrix-handover-test-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args],
      { encoding: "utf8" },
    ).trim();
  git("init", "-q", "-b", "main");
  await mkdir(join(repo, "src"));
  if (policy?.ignore) await writeFile(join(repo, ".gitignore"), policy.ignore);
  if (policy?.attributes) await writeFile(join(repo, ".gitattributes"), policy.attributes);
  if (policy?.config) await writeFile(join(repo, "matrix.config.ts"), policy.config);
  for (const root of policy?.packageRoots ?? []) {
    await mkdir(join(repo, root), { recursive: true });
    await writeFile(join(repo, root, "package.json"), "{}\n");
  }
  await writeFile(
    join(repo, "src/answer.ts"),
    Buffer.from(
      "export const answer = 1;\n",
      policy?.attributes?.includes("UTF-16LE") ? "utf16le" : "utf8",
    ),
  );
  if (policy?.largeFile) {
    // Sparse file above the in-memory source cap: cheap on disk, real bytes for git and hashing.
    const handle = await open(join(repo, policy.largeFile), "wx");
    await handle.truncate(SOURCE_READ_LIMIT + 4096);
    await handle.close();
  }
  git("add", ".");
  git("commit", "-qm", "fixture");
  const workspace = new NativeWorkspace({
    root: await mkdtemp(join(tmpdir(), "matrix-handover-wt-")),
  });
  const prepared = await workspace.prepare({
    projectId: "qa",
    ticketId: "tiny",
    repoPath: repo,
    baseBranch: "main",
    branch: policy?.branch ?? "matrix/tiny",
  });
  const port = new WorktreeGitPort({ trusted: workspace.trusted });
  const head = await port.headSha(prepared.workdir);
  const options = {
    expectedHead: head,
    approvedPaths: ["src"],
    message: "fixture handover",
    scan: async () => ({
      kind: "secret-scan" as const,
      ok: true,
      summary: "FAKE scanner for unit test only",
    }),
  };
  return { repo, git, prepared, port, head, options, workspace };
}

describe("host-mediated handover (real git, explicitly fake scanner)", () => {
  test.each([true, false])(
    "explicit BASE declarations exclude nested artifacts (ignored=%s)",
    async (ignored) => {
      const { prepared, port, options } = await fixture({
        config:
          'export default { mobile: { framework: "expo" }, frontend: { framework: "react", bundler: "next" }, process: { disposableArtifacts: ["node_modules/", "backend/node_modules/", "web/dist/", "app/.expo/", "web/.next/"] } };',
        ...(ignored ? { ignore: "node_modules/\ndist/\n.expo/\n.next/\n" } : {}),
        packageRoots: [".", "backend", "app", "web"],
      });
      const artifacts = [
        "node_modules/dependency/index.js",
        "backend/node_modules/dependency/index.js",
        "web/dist/bundle.js",
        "app/.expo/state.json",
        "web/.next/cache.json",
      ];
      for (const path of artifacts) {
        await mkdir(join(prepared.workdir, path, ".."), { recursive: true });
        await writeFile(join(prepared.workdir, path), "disposable");
      }
      await writeFile(join(prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
      const result = await port.commitImplementation(prepared.workdir, {
        ...options,
        scan: async (snapshot, binding) => {
          // Only blobs that differ from the expected HEAD are scanned and bound.
          expect(binding.objects.map((object) => object.path)).toEqual(["src/answer.ts"]);
          for (const path of artifacts) expect(existsSync(join(snapshot, path))).toBe(false);
          return options.scan();
        },
      });
      expect(await port.cleanForChecks(prepared.workdir)).toBe(result.headSha);
      for (const path of artifacts)
        expect(await readFile(join(prepared.workdir, path), "utf8")).toBe("disposable");
    },
    30_000,
  );

  test("only BASE declarations authorize custom ignored artifacts", async () => {
    const { prepared, port, options } = await fixture({
      config:
        'const config = { process: { disposableArtifacts: ["cache/"] } } as const; export default config;',
      ignore: "cache/\nsrc/private.ts\n",
    });
    await mkdir(join(prepared.workdir, "cache"));
    await writeFile(join(prepared.workdir, "cache/result"), "preserve");
    await writeFile(join(prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
    const result = await port.commitImplementation(prepared.workdir, options);
    expect(await port.cleanForChecks(prepared.workdir)).toBe(result.headSha);
    await writeFile(
      join(prepared.workdir, "matrix.config.ts"),
      'export default { process: { disposableArtifacts: ["src/"] } };',
    );
    await writeFile(join(prepared.workdir, "src/private.ts"), "preserve source");
    await expect(
      port.commitImplementation(prepared.workdir, { ...options, expectedHead: result.headSha }),
    ).rejects.toThrow(/ignored artifact/);
    await expect(port.cleanForChecks(prepared.workdir)).rejects.toThrow(/ignored artifact/);
    expect(await readFile(join(prepared.workdir, "src/private.ts"), "utf8")).toBe(
      "preserve source",
    );
    expect(await readFile(join(prepared.workdir, "cache/result"), "utf8")).toBe("preserve");
  }, 30_000);

  test("tracked disposable-looking source remains scanned", async () => {
    const { prepared, port, options } = await fixture({
      config: 'export default { process: { disposableArtifacts: ["src/"] } };',
    });
    await writeFile(join(prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
    await port.commitImplementation(prepared.workdir, {
      ...options,
      scan: async (snapshot, binding) => {
        expect(binding.objects.some((object) => object.path === "src/answer.ts")).toBe(true);
        expect(await readFile(join(snapshot, "src/answer.ts"), "utf8")).toContain("= 2");
        return options.scan();
      },
    });
  }, 30_000);
  test.each(["src/new.ts", "unknown.bin", "node_modules/package/index.js"])(
    "preserves ignored %s during handover and cleanup",
    async (path) => {
      const { prepared, port, head, options } = await fixture({ ignore: `${path}\n` });
      const target = join(prepared.workdir, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, "uncommitted source");
      await expect(port.commitImplementation(prepared.workdir, options)).rejects.toThrow(
        /ignored artifact/,
      );
      await expect(port.cleanForChecks(prepared.workdir)).rejects.toThrow(/ignored artifact/);
      expect(await readFile(target, "utf8")).toBe("uncommitted source");
      expect(await port.headSha(prepared.workdir)).toBe(head);
    },
    30_000,
  );

  test("new ignore rules cannot authorize deletion", async () => {
    const { prepared, port, options } = await fixture();
    await writeFile(join(prepared.workdir, ".gitignore"), "src/new.ts\n");
    await writeFile(join(prepared.workdir, "src/new.ts"), "preserve");
    await expect(port.commitImplementation(prepared.workdir, options)).rejects.toThrow(
      /ignored artifact/,
    );
    await expect(port.cleanForChecks(prepared.workdir)).rejects.toThrow();
    expect(await readFile(join(prepared.workdir, "src/new.ts"), "utf8")).toBe("preserve");
  }, 30_000);

  test("hardlinked source refuses before scanning or staging", async () => {
    const { prepared, port, options, head } = await fixture();
    const outside = join(await mkdtemp(join(tmpdir(), "matrix-hardlink-")), "outside.ts");
    await writeFile(outside, "export const answer = 2;\n");
    await rm(join(prepared.workdir, "src/answer.ts"));
    await link(outside, join(prepared.workdir, "src/answer.ts"));
    let scanned = false;
    await expect(
      port.commitImplementation(prepared.workdir, {
        ...options,
        scan: async () => {
          scanned = true;
          return options.scan();
        },
      }),
    ).rejects.toThrow(/hardlinked/);
    expect(scanned).toBe(false);
    expect(await port.headSha(prepared.workdir)).toBe(head);
    expect(await readFile(outside, "utf8")).toContain("= 2");
  }, 30_000);

  test("staging reads the FD-validated host snapshot, not a raced live hardlink", async () => {
    const { prepared, options, head, workspace } = await fixture();
    const outside = join(await mkdtemp(join(tmpdir(), "matrix-staging-race-")), "outside.ts");
    await writeFile(outside, "external content must not be staged");
    await writeFile(join(prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
    const port = new WorktreeGitPort({
      trusted: workspace.trusted,
      executor: async (spec, onLine, signal) => {
        if (spec.cmd.includes("add")) {
          await rm(join(prepared.workdir, "src/answer.ts"));
          await link(outside, join(prepared.workdir, "src/answer.ts"));
        }
        return hostExecutor(spec, onLine, signal);
      },
    });
    let scanned = false;
    await expect(
      port.commitImplementation(prepared.workdir, {
        ...options,
        scan: async (source) => {
          scanned = true;
          expect(await readFile(join(source, "src/answer.ts"), "utf8")).toContain("= 2");
          return options.scan();
        },
      }),
    ).rejects.toThrow(/hardlinked/);
    expect(scanned).toBe(true);
    expect(await port.headSha(prepared.workdir)).toBe(head);
  }, 30_000);

  test("missing handover scanner leaves the branch and source unchanged", async () => {
    const { prepared, options, port, head } = await fixture();
    await writeFile(join(prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
    await expect(
      port.commitImplementation(prepared.workdir, {
        ...options,
        scan: (source, binding) => scanSourceSnapshot(source, [], "/nonexistent/gitleaks", binding),
      }),
    ).rejects.toThrow(/secret scan failed/);
    expect(await port.headSha(prepared.workdir)).toBe(head);
    expect(await readFile(join(prepared.workdir, "src/answer.ts"), "utf8")).toContain("= 2");
  }, 30_000);

  test("cancellation during the final branch check cannot advance the reference", async () => {
    const { prepared, options, head, workspace } = await fixture();
    const controller = new AbortController();
    let branchChecks = 0;
    const port = new WorktreeGitPort({
      trusted: workspace.trusted,
      executor: async (spec, onLine, signal) => {
        const result = await hostExecutor(spec, onLine, signal);
        if (spec.cmd.includes("symbolic-ref") && ++branchChecks === 2) controller.abort();
        return result;
      },
    });
    await writeFile(join(prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
    await expect(
      port.commitImplementation(prepared.workdir, {
        ...options,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(await port.headSha(prepared.workdir)).toBe(head);
  }, 30_000);

  test("UTF-16 attributes cannot hide a raw committed token from the actual scanner", async () => {
    const { prepared, port, options, head } = await fixture({
      attributes: "src/answer.ts working-tree-encoding=UTF-16LE eol=crlf\n",
    });
    const token = ["ghp", randomBytes(27).toString("base64url").replace(/[_-]/g, "Z")].join("_");
    await writeFile(
      join(prepared.workdir, "src/answer.ts"),
      Buffer.from(`token = "${token}"\r\n`, "utf16le"),
    );
    let rawScanned = false;
    await expect(
      port.commitImplementation(prepared.workdir, {
        ...options,
        scan: async (source, binding) => {
          const raw = await readFile(join(source, "src/answer.ts"));
          expect(raw.includes(Buffer.from(token))).toBe(true);
          expect(raw.includes(Buffer.from(token, "utf16le"))).toBe(false);
          rawScanned = true;
          return scanSourceSnapshot(source, [], "gitleaks", binding);
        },
      }),
    ).rejects.toThrow(/secret scan failed/);
    expect(rawScanned).toBe(true);
    expect(await port.headSha(prepared.workdir)).toBe(head);
  }, 30_000);

  test("actual scanner produces a receipt bound to the committed tree and blobs", async () => {
    const { prepared, port, options, git } = await fixture();
    await writeFile(join(prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
    const committed = await port.commitImplementation(prepared.workdir, {
      ...options,
      scan: (source, binding) => scanSourceSnapshot(source, [], "gitleaks", binding),
    });
    expect(committed.receipt.data).toEqual(
      expect.objectContaining({
        tree: git("rev-parse", `${committed.headSha}^{tree}`),
        objects: [
          { path: "src/answer.ts", sha: git("rev-parse", `${committed.headSha}:src/answer.ts`) },
        ],
        headSha: committed.headSha,
      }),
    );
    expect(await port.cleanForChecks(prepared.workdir)).toBe(committed.headSha);
  }, 30_000);
  test("commit gate accepts the recorded Orca user-prefixed branch, refuses other branches", async () => {
    const prefixed = await fixture({ branch: "NeOMakinG/matrix-NEO-7" });
    await writeFile(join(prefixed.prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
    await expect(
      prefixed.port.commitImplementation(prefixed.prepared.workdir, prefixed.options),
    ).resolves.toMatchObject({ headSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const other = await fixture({ branch: "feature/NEO-7" });
    await writeFile(join(other.prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
    await expect(
      other.port.commitImplementation(other.prepared.workdir, other.options),
    ).rejects.toThrow(/Matrix ticket branch/);
  }, 30_000);
  test("existing-repo policy: custom editable paths, Orca branch names, no .matrix in the commit", async () => {
    const { prepared, port, options, git } = await fixture({ branch: "matrix-NEO-7" });
    await mkdir(join(prepared.workdir, "app/src/features"), { recursive: true });
    await writeFile(join(prepared.workdir, "app/src/features/a.ts"), "export const a = 1;\n");
    const committed = await port.commitImplementation(prepared.workdir, {
      ...options,
      approvedPaths: ["app", "docs"],
    });
    const files = git("ls-tree", "-r", "--name-only", committed.headSha).split("\n");
    expect(files).toContain("app/src/features/a.ts");
    expect(files.some((f) => f.startsWith(".matrix/"))).toBe(false);
    // Dot paths stay denied even when listed.
    await mkdir(join(prepared.workdir, ".github/workflows"), { recursive: true });
    await writeFile(join(prepared.workdir, ".github/workflows/ci.yml"), "on: push\n");
    await expect(
      port.commitImplementation(prepared.workdir, {
        ...options,
        expectedHead: committed.headSha,
        approvedPaths: ["app", ".github"],
      }),
    ).rejects.toThrow(/unapproved implementation path/);
  }, 30_000);

  test("scans immutable source before committing and keeps base unchanged", async () => {
    const { prepared, port, head, options, git } = await fixture();
    await writeFile(join(prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
    const committed = await port.commitImplementation(prepared.workdir, {
      ...options,
      scan: async (source) => {
        expect(existsSync(join(source, ".git"))).toBe(false);
        expect(await readFile(join(source, "src/answer.ts"), "utf8")).toContain("= 2");
        expect(await port.headSha(prepared.workdir)).toBe(head);
        return options.scan();
      },
    });
    expect(committed.headSha).not.toBe(head);
    expect(git("rev-parse", "main")).toBe(head);
    expect(await port.isClean(prepared.workdir)).toBe(true);
    expect(await port.cleanForChecks(prepared.workdir)).toBe(committed.headSha);
  }, 30_000);

  test.each([
    "scan failure",
    "source race",
    "cancelled scan",
    "git pointer",
    "nested git",
    "symlink",
    "unapproved metadata",
    "ignored source race",
    "hardlink race",
  ])(
    "refuses %s without advancing HEAD",
    async (mode) => {
      const { prepared, port, head, options, git } = await fixture({ ignore: "src/new.ts\n" });
      const controller = new AbortController();
      await writeFile(join(prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
      if (mode === "git pointer")
        await writeFile(join(prepared.workdir, ".git"), "gitdir: /nonexistent\n");
      if (mode === "nested git") await mkdir(join(prepared.workdir, "src/.git"));
      if (mode === "symlink") await symlink("/etc/passwd", join(prepared.workdir, "src/link"));
      if (mode === "unapproved metadata")
        await writeFile(join(prepared.workdir, ".gitleaksignore"), "*\n");
      await expect(
        port.commitImplementation(prepared.workdir, {
          ...options,
          signal: controller.signal,
          scan: async () => {
            if (mode === "cancelled scan") controller.abort();
            if (mode === "source race")
              await writeFile(
                join(prepared.workdir, "src/answer.ts"),
                "export const answer = 3;\n",
              );
            if (mode === "ignored source race")
              await writeFile(join(prepared.workdir, "src/new.ts"), "preserved race");
            if (mode === "hardlink race")
              await link(
                join(prepared.workdir, "src/answer.ts"),
                join(prepared.workdir, "src/alias.ts"),
              );
            return {
              kind: "secret-scan",
              ok: mode !== "scan failure",
              summary: "FAKE test scanner",
            };
          },
        }),
      ).rejects.toThrow();
      expect(git("rev-parse", "matrix/tiny")).toBe(head);
    },
    30_000,
  );
});

describe("generic build directories are not disposable by default", () => {
  test("a legitimate src/package.json does not exempt authored src/coverage source", async () => {
    const { prepared, port, options, head } = await fixture({
      config: 'export default { backend: { kind: "node-api" } };',
      packageRoots: ["src"],
    });
    await mkdir(join(prepared.workdir, "src/coverage"), { recursive: true });
    const target = join(prepared.workdir, "src/coverage/secret.ts");
    await writeFile(target, "authored secret source\n");
    let scanned = false;
    await expect(
      port.commitImplementation(prepared.workdir, {
        ...options,
        scan: async (snapshot, binding) => {
          expect(binding.objects.some((object) => object.path === "src/coverage/secret.ts")).toBe(
            true,
          );
          expect(await readFile(join(snapshot, "src/coverage/secret.ts"), "utf8")).toContain(
            "authored secret",
          );
          scanned = true;
          return { kind: "secret-scan", ok: false, summary: "secret found" };
        },
      }),
    ).rejects.toThrow(/secret scan/);
    expect(scanned).toBe(true);
    expect(await port.headSha(prepared.workdir)).toBe(head);
    expect(await readFile(target, "utf8")).toBe("authored secret source\n");
  }, 30_000);
  test("a new file under src/build is committed and scanned, not skipped", async () => {
    const { prepared, port, options } = await fixture({
      config: 'export default { backend: { kind: "node-api" } };',
    });
    await mkdir(join(prepared.workdir, "src/build"), { recursive: true });
    await writeFile(join(prepared.workdir, "src/build/secret.ts"), "export const value = 1;\n");
    let scanned = false;
    await port.commitImplementation(prepared.workdir, {
      ...options,
      scan: async (snapshot, binding) => {
        expect(binding.objects.some((object) => object.path === "src/build/secret.ts")).toBe(true);
        expect(await readFile(join(snapshot, "src/build/secret.ts"), "utf8")).toContain(
          "value = 1",
        );
        scanned = true;
        return options.scan();
      },
    });
    expect(scanned).toBe(true);
  }, 30_000);

  describe("tracked files above the in-memory source cap", () => {
    const large = "src/model.bin";

    test("unchanged large file: fingerprint streams, commit succeeds, scan skips it", async () => {
      const { prepared, port, options, git } = await fixture({ largeFile: large });
      const before = await port.treeState(prepared.workdir);
      expect(await port.treeState(prepared.workdir)).toBe(before);
      await writeFile(join(prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
      expect(await port.treeState(prepared.workdir)).not.toBe(before);
      const committed = await port.commitImplementation(prepared.workdir, {
        ...options,
        scan: async (_snapshot, binding) => {
          expect(binding.objects.map((object) => object.path)).toEqual(["src/answer.ts"]);
          return options.scan();
        },
      });
      expect(git("cat-file", "-s", `${committed.headSha}:${large}`)).toBe(
        String(SOURCE_READ_LIMIT + 4096),
      );
      expect(await port.cleanForChecks(prepared.workdir)).toBe(committed.headSha);
    }, 60_000);

    test("hardlinked large file is refused by the fingerprint and the commit", async () => {
      const { prepared, port, options, head } = await fixture({ largeFile: large });
      const outside = join(await mkdtemp(join(tmpdir(), "matrix-large-link-")), "outside.bin");
      await link(join(prepared.workdir, large), outside);
      await expect(port.treeState(prepared.workdir)).rejects.toThrow(/hardlinked/);
      await writeFile(join(prepared.workdir, "src/answer.ts"), "export const answer = 2;\n");
      await expect(port.commitImplementation(prepared.workdir, options)).rejects.toThrow(
        /hardlinked/,
      );
      expect(await port.headSha(prepared.workdir)).toBe(head);
    }, 60_000);

    test("large file behind a symlinked directory is refused", async () => {
      const { prepared, port, options, head } = await fixture({ largeFile: large });
      const outside = await mkdtemp(join(tmpdir(), "matrix-large-symlink-"));
      const handle = await open(join(outside, "model.bin"), "wx");
      await handle.truncate(SOURCE_READ_LIMIT + 4096);
      await handle.close();
      await rm(join(prepared.workdir, "src"), { recursive: true });
      await symlink(outside, join(prepared.workdir, "src"));
      await expect(port.commitImplementation(prepared.workdir, options)).rejects.toThrow(
        /symlink|tampering/,
      );
      expect(await port.headSha(prepared.workdir)).toBe(head);
    }, 60_000);

    test("renames and out-of-gate commits since BASE stay scanned", async () => {
      const { prepared, port, options } = await fixture({ largeFile: large });
      const wt = (...args: string[]) =>
        execFileSync(
          "git",
          ["-C", prepared.workdir, "-c", "user.name=T", "-c", "user.email=t@localhost", ...args],
          { encoding: "utf8" },
        ).trim();
      await writeFile(join(prepared.workdir, "src/outside.ts"), "export const leaked = 1;\n");
      wt("add", "src/outside.ts");
      wt("commit", "-qm", "committed outside the gate");
      await rename(join(prepared.workdir, "src/answer.ts"), join(prepared.workdir, "src/moved.ts"));
      await port.commitImplementation(prepared.workdir, {
        ...options,
        expectedHead: wt("rev-parse", "HEAD"),
        scan: async (_snapshot, binding) => {
          expect(binding.objects.map((object) => object.path).sort()).toEqual([
            "src/moved.ts",
            "src/outside.ts",
          ]);
          return options.scan();
        },
      });
    }, 60_000);

    test("a mode-only change makes a large BASE blob rescanned (refused by the cap)", async () => {
      const { prepared, port, options, head } = await fixture({ largeFile: large });
      await chmod(join(prepared.workdir, large), 0o755);
      await expect(port.commitImplementation(prepared.workdir, options)).rejects.toThrow(
        /maxBuffer/,
      );
      expect(await port.headSha(prepared.workdir)).toBe(head);
    }, 60_000);

    test("an agent-modified oversized file is still refused", async () => {
      const { prepared, port, options, head } = await fixture({ largeFile: large });
      await appendFile(join(prepared.workdir, large), "agent bytes");
      let scanned = false;
      await expect(
        port.commitImplementation(prepared.workdir, {
          ...options,
          scan: async () => {
            scanned = true;
            return options.scan();
          },
        }),
      ).rejects.toThrow(/maxBuffer/);
      expect(scanned).toBe(false);
      expect(await port.headSha(prepared.workdir)).toBe(head);
    }, 60_000);
  });
});
