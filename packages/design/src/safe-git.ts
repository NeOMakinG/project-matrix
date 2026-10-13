import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  hostUiContextSchema,
  type ProjectConfig,
  targetsUi,
  type WorkflowState,
} from "@matrix/core";
import { extractImports } from "@matrix/graph";
import { assertNoSymlinkChain } from "@matrix/safe-fs";
import { findNestedGitEntries, gitLocation, safeGitEnv, verifyWorktreeLink } from "@matrix/sandbox";
import type { TrustedWorktrees } from "@matrix/workspace";
import { z } from "zod";
import { readBounded } from "./storage.js";
import type { SafeGitReadOnlyPort } from "./ui-context.js";

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const paths = hostUiContextSchema.shape.files;
const graphSchema = z.object({
  version: z.literal(1),
  modules: z
    .array(
      z.object({
        path: z.string(),
        imports: z.array(
          z.object({
            specifier: z.string().optional(),
            target: z.string().optional(),
            package: z.string().optional(),
            computed: z.boolean().optional(),
          }),
        ),
      }),
    )
    .max(100000),
});
const run = promisify(execFile);
export interface ReadOnlyGitQuery {
  execute(args: string[], options: { cwd: string; env: Record<string, string> }): Promise<string>;
}
const nativeQuery: ReadOnlyGitQuery = {
  async execute(args, options) {
    const result = await run("git", args, {
      ...options,
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    });
    return result.stdout;
  },
};
export function classifyBaseGraph(
  raw: unknown,
  files: string[],
  serverEntrypoints: string[],
  serverPackages: string[] = [],
) {
  const graph = graphSchema.parse(raw);
  const modules = new Map(graph.modules.map((item) => [item.path, item]));
  paths.parse([...modules.keys()]);
  if (
    modules.size !== graph.modules.length ||
    [...modules.keys()].some((path) => !files.includes(path))
  )
    throw new Error("base graph inventory mismatch");
  const ui = new Set(files.filter((path) => targetsUi([], [path])));
  for (const item of modules.values()) {
    if (
      item.imports.some(
        (edge) =>
          edge.package && /^(react|react-dom|vue|svelte|@angular\/core|next)$/.test(edge.package),
      )
    )
      ui.add(item.path);
  }
  const server = new Set(paths.parse(serverEntrypoints));
  if ([...server].some((path) => !modules.has(path)))
    throw new Error("server entrypoint missing from base graph");
  const closure = (set: Set<string>) => {
    for (let previous = -1; previous !== set.size; ) {
      previous = set.size;
      for (const path of [...set]) {
        for (const edge of modules.get(path)?.imports ?? []) {
          if (edge.target) {
            paths.parse([edge.target]);
            if (!modules.has(edge.target)) throw new Error("incomplete base graph");
            set.add(edge.target);
          }
        }
      }
    }
  };
  closure(ui);
  closure(server);
  const uncertainServer = [...server].some((path) =>
    modules
      .get(path)
      ?.imports.some(
        (edge) =>
          edge.computed ||
          (edge.package &&
            !edge.package.startsWith("node:") &&
            !serverPackages.includes(edge.package)),
      ),
  );
  return files.map((path) => ({
    path,
    role: ui.has(path)
      ? ("ui" as const)
      : server.has(path) && !uncertainServer
        ? ("server" as const)
        : ("unknown" as const),
  }));
}
export function classifyChangedSource(
  path: string,
  text: string,
  baseSpecifiers: string[],
): "ui" | "unknown" | "server" {
  if (
    targetsUi([], [path]) ||
    /\b(React|react|react-dom|jsx-runtime|document|window|HTMLElement|innerHTML|createElement)\b|<[A-Za-z][^>]*>/.test(
      text,
    )
  )
    return "ui";
  if (!/\.[cm]?[jt]s$/.test(path)) return "unknown";
  const imports = extractImports(path, text);
  if (imports.some((item) => item.computed || !baseSpecifiers.includes(item.specifier)))
    return "unknown";
  return "server";
}
export class SafeGitUiReader implements SafeGitReadOnlyPort {
  constructor(
    readonly options: {
      trusted: Pick<TrustedWorktrees, "lookup">;
      serverEntrypoints: string[];
      serverPackages?: string[];
      query?: ReadOnlyGitQuery;
    },
  ) {}
  async inspect(project: ProjectConfig, workflow: WorkflowState) {
    if (project.id !== workflow.projectId || !workflow.workdir)
      throw new Error("trusted worktree scope required");
    const workdir = workflow.workdir;
    const entry = await this.options.trusted.lookup(workdir);
    const baseSha = sha.parse(entry.baseSha);
    await verifyWorktreeLink(workdir, entry.gitdir);
    if ((await findNestedGitEntries(workdir)).length) throw new Error("nested repository denied");
    const query = this.options.query ?? nativeQuery;
    const filters = await query.execute(
      ["--no-optional-locks", ...gitLocation(entry.gitdir), "config", "--list", "--name-only"],
      { cwd: entry.gitdir, env: safeGitEnv({ GIT_OPTIONAL_LOCKS: "0" }) },
    );
    const drivers = [
      ...new Set(
        filters.split("\n").flatMap((key) => /^filter\.(.+)\.[^.]+$/.exec(key)?.[1] ?? []),
      ),
    ];
    const extra: Array<[string, string]> = drivers.flatMap((driver) => [
      [`filter.${driver}.clean`, ""],
      [`filter.${driver}.smudge`, ""],
      [`filter.${driver}.process`, ""],
      [`filter.${driver}.required`, "false"],
    ]);
    const read = (args: string[], tree = false) =>
      query.execute(
        [
          "--no-optional-locks",
          "--no-pager",
          ...gitLocation(entry.gitdir, tree ? workdir : undefined),
          ...args,
        ],
        { cwd: entry.gitdir, env: safeGitEnv({ GIT_OPTIONAL_LOCKS: "0" }, extra) },
      );
    const headSha = sha.parse((await read(["rev-parse", "--verify", "HEAD"])).trim());
    await read(["merge-base", "--is-ancestor", baseSha, headSha]);
    const inventory = await read(["ls-tree", "-r", "-z", baseSha]);
    const files = paths.parse(
      inventory
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const match = /^(100644|100755) blob [a-f0-9]+\t(.+)$/.exec(record);
          if (!match?.[2]) throw new Error("non-regular base inventory entry");
          return match[2];
        }),
    );
    const rawGraph = await read(["cat-file", "blob", `${baseSha}:.matrix/graph/code.json`]);
    if (rawGraph.length > 2 * 1024 * 1024) throw new Error("graph size limit exceeded");
    const parsedGraph = graphSchema.parse(JSON.parse(rawGraph));
    const graph = classifyBaseGraph(
      parsedGraph,
      files,
      this.options.serverEntrypoints,
      this.options.serverPackages,
    );
    const committedAndDirty = await read(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "--no-renames",
        "-z",
        baseSha,
        "--",
      ],
      true,
    );
    const untracked = await read(["ls-files", "--others", "--exclude-standard", "-z"], true);
    const ignored = await read(
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      true,
    );
    if (ignored)
      throw new Error(
        "ignored worktree files prevent complete scope proof; clean via host check policy",
      );
    const changedPaths = paths.parse([
      ...new Set(`${committedAndDirty}${untracked}`.split("\0").filter(Boolean)),
    ]);
    const inspectedContents = new Map<string, Buffer>();
    for (const path of changedPaths) {
      const absolute = join(workdir, path);
      await assertNoSymlinkChain("/", absolute);
      const stat = await lstat(absolute).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (stat && !stat.isFile()) throw new Error("non-regular implementation path");
      if (stat && stat.size > 0) {
        const bytes = await readBounded(workdir, absolute, 2 * 1024 * 1024);
        inspectedContents.set(absolute, bytes);
        const item = graph.find((node) => node.path === path);
        if (item?.role === "server") {
          const baseSpecifiers =
            parsedGraph.modules
              .find((module) => module.path === path)
              ?.imports.flatMap((edge) => (edge.specifier ? [edge.specifier] : [])) ?? [];
          item.role = classifyChangedSource(path, bytes.toString("utf8"), baseSpecifiers);
        }
      }
    }
    if (
      sha.parse((await read(["rev-parse", "--verify", "HEAD"])).trim()) !== headSha ||
      (await read(
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--name-only",
          "--no-renames",
          "-z",
          baseSha,
          "--",
        ],
        true,
      )) !== committedAndDirty ||
      (await read(["ls-files", "--others", "--exclude-standard", "-z"], true)) !== untracked
    )
      throw new Error("worktree changed during UI inspection");
    for (const [path, bytes] of inspectedContents) {
      if (!bytes.equals(await readBounded(workdir, path, 2 * 1024 * 1024)))
        throw new Error("source changed during UI inspection");
    }
    return {
      baseSha,
      headSha,
      complete: true as const,
      files,
      graph,
      changes: changedPaths.map((path) => ({ path })),
    };
  }
}
