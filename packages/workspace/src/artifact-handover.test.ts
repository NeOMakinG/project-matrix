import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LineExecutor } from "@matrix/sandbox";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WorktreeGitPort } from "./git-port.js";
import { TrustedWorktrees } from "./trusted.js";

const blobs = vi.hoisted(() => new Map<string, string>());
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = Object.assign(
    () => {
      throw new Error("subprocess forbidden in fake Git test");
    },
    {
      [promisify.custom]: async (command: string, args: string[]) => {
        expect(command).toBe("git");
        expect(args).toContain("cat-file");
        const content = blobs.get(args.at(-1)!);
        if (content === undefined) throw new Error("unknown fake blob");
        return { stdout: Buffer.from(content), stderr: Buffer.alloc(0) };
      },
    },
  );
  return { ...actual, execFile };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(config: string, artifacts: string[], ignored = true, staged = false) {
  const root = await mkdtemp(join(tmpdir(), "matrix-artifact-fake-"));
  roots.push(root);
  const workdir = join(root, "worktree");
  const gitdir = join(root, "host-gitdir");
  await mkdir(join(workdir, "src"), { recursive: true });
  await mkdir(gitdir);
  await writeFile(join(workdir, ".git"), `gitdir: ${gitdir}\n`);
  await writeFile(join(workdir, "matrix.config.ts"), config);
  await writeFile(join(workdir, "src/answer.ts"), "export const answer = 2;\n");
  for (const path of artifacts) {
    await mkdir(join(workdir, path, ".."), { recursive: true });
    await writeFile(join(workdir, path), "preserve artifact");
  }
  const base = "a".repeat(40);
  const next = "b".repeat(40);
  const tree = "c".repeat(40);
  const oldTree = "d".repeat(40);
  const configSha = "e".repeat(40);
  const sourceSha = "f".repeat(40);
  blobs.set(configSha, config);
  blobs.set(sourceSha, "export const answer = 2;\n");
  const records =
    `100644 blob ${configSha}\tmatrix.config.ts\0` + `100644 blob ${sourceSha}\tsrc/answer.ts\0`;
  let committed = false;
  const executor: LineExecutor = async (spec, onLine) => {
    const commands = [
      "config",
      "ls-tree",
      "rev-list",
      "ls-files",
      "cat-file",
      "rev-parse",
      "symbolic-ref",
      "status",
      "diff",
      "read-tree",
      "add",
      "write-tree",
      "commit-tree",
      "update-ref",
      "update-index",
    ];
    const command = spec.cmd.find((argument) => commands.includes(argument));
    const args = spec.cmd.slice(spec.cmd.indexOf(command!) + 1);
    let output = "";
    switch (command) {
      case "config":
      case "rev-list":
      case "diff":
      case "add":
        break;
      case "read-tree":
        if (!spec.env.GIT_INDEX_FILE) staged = false;
        break;
      case "ls-tree":
        output = args.includes("matrix.config.ts")
          ? `100644 blob ${configSha}\tmatrix.config.ts\0`
          : args.includes("--name-only")
            ? "matrix.config.ts\0src/answer.ts\0"
            : records;
        break;
      case "ls-files":
        if (args.includes("--stage")) {
          output = records.replaceAll(" blob ", " ").replaceAll("\t", " 0\t");
        } else {
          if (args.includes("--cached"))
            output +=
              "matrix.config.ts\0src/answer.ts\0" +
              (staged ? artifacts.map((path) => `${path}\0`).join("") : "");
          if (
            args.includes("--others") &&
            !staged &&
            !(args.includes("--exclude-standard") && ignored)
          )
            output += artifacts.map((path) => `${path}\0`).join("");
        }
        break;
      case "cat-file":
        output = args.includes("-s") ? String(Buffer.byteLength(config)) : config;
        break;
      case "rev-parse":
        output = args.includes("HEAD^{tree}") ? oldTree : committed ? next : base;
        break;
      case "symbolic-ref":
        output = "refs/heads/matrix/test";
        break;
      case "status":
        output =
          (committed ? "" : " M src/answer.ts\0") +
          (staged
            ? artifacts.map((path) => `A  ${path}\0`).join("")
            : ignored
              ? ""
              : artifacts.map((path) => `?? ${path}\0`).join(""));
        break;
      case "write-tree":
        output = tree;
        break;
      case "commit-tree":
        output = next;
        break;
      case "update-ref":
        committed = true;
        break;
      case "update-index":
        staged = false;
        break;
      default:
        throw new Error(`unexpected fake Git command: ${spec.cmd.join(" ")}`);
    }
    if (output) onLine(output);
    return { exitCode: 0, timedOut: false, cancelled: false, stderrTail: "" };
  };
  const trusted = new TrustedWorktrees();
  await trusted.record(workdir, { gitdir, commonDir: gitdir, baseSha: base });
  const port = new WorktreeGitPort({ trusted, executor });
  const scan = vi.fn(async (snapshot: string, binding: { objects: Array<{ path: string }> }) => {
    expect(binding.objects.map((object) => object.path)).toEqual([
      "matrix.config.ts",
      "src/answer.ts",
    ]);
    expect(await readFile(join(snapshot, "src/answer.ts"), "utf8")).toContain("= 2");
    return { kind: "secret-scan" as const, ok: true, summary: "fake scanner" };
  });
  const options = { expectedHead: base, approvedPaths: ["src"], message: "test", scan };
  return { workdir, port, options, next };
}

describe("handover artifact regressions with fake Git, no subprocesses", () => {
  test("newly staged disposables are excluded without excluding tracked source", async () => {
    const { workdir, port, options, next } = await fixture(
      'export default { backend: { kind: "node-api" } };',
      ["dist/result.js"],
      false,
      true,
    );
    expect((await port.commitImplementation(workdir, options)).headSha).toBe(next);
    expect(await port.cleanForChecks(workdir)).toBe(next);
    expect(await readFile(join(workdir, "dist/result.js"), "utf8")).toBe("preserve artifact");
  });

  test.each(["symlink", "hardlink"])("tracked %s protections remain enforced", async (kind) => {
    const { workdir, port, options } = await fixture(
      'export default { process: { disposableArtifacts: ["src/"] } };',
      [],
    );
    const outside = join(workdir, "..", "outside.ts");
    await writeFile(outside, "preserve outside source");
    await rm(join(workdir, "src/answer.ts"));
    await (kind === "symlink" ? symlink : link)(outside, join(workdir, "src/answer.ts"));
    if (kind === "hardlink") expect((await lstat(join(workdir, "src/answer.ts"))).nlink).toBe(2);
    await expect(port.commitImplementation(workdir, options)).rejects.toThrow(
      kind === "symlink" ? /symlink/ : /hardlinked/,
    );
    expect(options.scan).not.toHaveBeenCalled();
    expect(await readFile(outside, "utf8")).toBe("preserve outside source");
  });

  test.each([true, false])(
    "root and nested node_modules plus dist are excluded (ignored=%s)",
    async (ignored) => {
      const artifacts = [
        "node_modules/pkg/index.js",
        "backend/node_modules/pkg/index.js",
        "web/dist/bundle.js",
      ];
      const { workdir, port, options, next } = await fixture(
        'export default { mobile: { framework: "expo" } };',
        artifacts,
        ignored,
      );
      expect((await port.commitImplementation(workdir, options)).headSha).toBe(next);
      expect(options.scan).toHaveBeenCalledOnce();
      expect(await port.cleanForChecks(workdir)).toBe(next);
      for (const path of artifacts)
        expect(await readFile(join(workdir, path), "utf8")).toBe("preserve artifact");
    },
  );

  test("undeclared ignored source refuses and is preserved", async () => {
    const { workdir, port, options } = await fixture(
      'export default { mobile: { framework: "expo" } };',
      ["src/private.ts"],
    );
    await expect(port.commitImplementation(workdir, options)).rejects.toThrow(/ignored artifact/);
    await expect(port.cleanForChecks(workdir)).rejects.toThrow(/ignored artifact/);
    expect(options.scan).not.toHaveBeenCalled();
    expect(await readFile(join(workdir, "src/private.ts"), "utf8")).toBe("preserve artifact");
  });

  test("worktree declarations cannot authorize ignored source", async () => {
    const { workdir, port, options } = await fixture(
      'export default { process: { disposableArtifacts: ["cache/"] } };',
      ["src/private.ts"],
    );
    await writeFile(
      join(workdir, "matrix.config.ts"),
      'export default { process: { disposableArtifacts: ["src/"] } };',
    );
    await expect(port.commitImplementation(workdir, options)).rejects.toThrow(/ignored artifact/);
    expect(await readFile(join(workdir, "src/private.ts"), "utf8")).toBe("preserve artifact");
  });

  test("BASE declarations authorize custom artifacts but never exempt tracked blobs", async () => {
    const { workdir, port, options, next } = await fixture(
      'const config = { process: { disposableArtifacts: ["cache/", "src/"] } } as const; export default config;',
      ["cache/output"],
    );
    expect((await port.commitImplementation(workdir, options)).headSha).toBe(next);
    expect(options.scan).toHaveBeenCalledOnce();
    expect(await port.cleanForChecks(workdir)).toBe(next);
  });
});
