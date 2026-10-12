import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import type { MatrixConfig } from "@matrix/config";
import {
  type Answers,
  buildConfig,
  type Contradiction,
  decisions,
  defaultPacks,
  findContradictions,
  type InferContext,
  inferAnswers,
  type Pack,
  type Question,
  resolve,
} from "@matrix/packs";
import { MarkdownTicketStore } from "@matrix/tickets/adapters/markdown";
import { adrFiles, configFile, contextFile, type Files, productGraph } from "./generate/docs";
import { scaffoldFiles } from "./generate/scaffold";

export interface InitOptions {
  answers: Answers;
  outDir: string;
  acceptRecommended: boolean;
  scaffold: boolean;
  /** Pre-fill answers from an existing repository. */
  existingRepo?: string;
  packs?: Pack[];
  date?: string;
}

export type InitResult =
  | { status: "missing"; missing: Question[] }
  | { status: "contradictions"; contradictions: Contradiction[] }
  | { status: "invalid"; issues: { path: string; message: string }[] }
  | {
      status: "ok";
      config: MatrixConfig;
      answers: Answers;
      files: string[];
      tickets: string[];
      warnings: string[];
      contradictions: Contradiction[];
    };

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo"]);

export async function scanRepo(root: string, limit = 5000): Promise<InferContext> {
  const files = new Set<string>();
  const dependencies = new Set<string>();
  async function walk(dir: string): Promise<void> {
    if (files.size >= limit) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        files.add(relative(root, full));
        if (entry.name === "package.json") {
          try {
            const pkg = JSON.parse(await readFile(full, "utf8")) as Record<
              string,
              Record<string, string>
            >;
            for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
              for (const name of Object.keys(pkg[key] ?? {})) dependencies.add(name);
            }
          } catch {
            // unreadable package.json: ignore, inference is best-effort
          }
        }
      }
    }
  }
  await walk(root);
  return { dependencies, files, env: { ...process.env } };
}

async function writeAll(outDir: string, files: Files): Promise<string[]> {
  const written: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const full = join(outDir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    written.push(path);
  }
  return written.sort();
}

async function seedBacklog(outDir: string, config: MatrixConfig): Promise<string[]> {
  const store = new MarkdownTicketStore(join(outDir, ".matrix/tickets"));
  const setup = await store.create({
    title: "Bootstrap repository and CI",
    body: "Install dependencies, make `typecheck`, `lint` and `test` pass, and add the CI workflow.",
    labels: ["setup"],
    priority: 1,
  });
  const ids = [setup.id];
  const extras: [boolean, string, string][] = [
    [
      config.backend.auth !== "none",
      "Authentication",
      `Set up ${config.backend.auth} with sign-up, sign-in and sessions.`,
    ],
    [
      config.observability.analytics !== "none",
      "Analytics events",
      `Wire ${config.observability.analytics} and track the success metrics: ${config.business.successMetrics.join(", ")}.`,
    ],
    [
      config.observability.errors !== "none",
      "Error tracking",
      `Wire ${config.observability.errors} in web and API so the prod loop can open fix tickets.`,
    ],
  ];
  for (const [enabled, title, body] of extras) {
    if (!enabled) continue;
    const t = await store.create({ title, body, labels: ["setup"], priority: 2, deps: [setup.id] });
    ids.push(t.id);
  }
  for (const feature of config.product.mvpScope) {
    const t = await store.create({
      title: `Feature: ${feature}`,
      body: `MVP feature for ${config.product.personas.map((p) => p.name).join(", ")}.\n\nSpike first: plan, affected ADRs and test plan.`,
      labels: ["feature", "mvp"],
      priority: 2,
      deps: [setup.id],
    });
    ids.push(t.id);
  }
  return ids;
}

/** Formats the generated project with the factory's own Biome so it passes `lint` out of the box. */
function formatWithBiome(dir: string): string | null {
  const bin = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
  const r = spawnSync(process.execPath, [bin, "check", "--write", "."], {
    cwd: dir,
    encoding: "utf8",
  });
  return r.status === 0
    ? null
    : `Biome reported issues after formatting: ${(r.stdout + r.stderr).split("\n").slice(-4).join(" ").trim()}`;
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const packs = opts.packs ?? defaultPacks;
  const inferred = opts.existingRepo ? inferAnswers(packs, await scanRepo(opts.existingRepo)) : {};
  const { answers, missing } = resolve(
    packs,
    { ...inferred, ...opts.answers },
    {
      acceptRecommended: opts.acceptRecommended,
    },
  );
  if (missing.length > 0) return { status: "missing", missing };

  const contradictions = findContradictions(answers);
  const errors = contradictions.filter((c) => c.severity === "error");
  if (errors.length > 0) return { status: "contradictions", contradictions: errors };

  const built = buildConfig(packs, answers);
  if (!built.ok) return { status: "invalid", issues: built.issues };
  const config = built.config;

  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const ds = decisions(packs, answers);
  let files: Files = {
    "matrix.config.ts": configFile(config),
    ".matrix/answers.json": `${JSON.stringify(answers, null, 2)}\n`,
    "CONTEXT.md": contextFile(config),
    ".matrix/graph/product.json": productGraph(config, ds),
    ...adrFiles(ds, date),
  };
  const warnings: string[] = [];
  if (opts.scaffold) {
    const s = scaffoldFiles(config);
    files = { ...s.files, ...files };
    warnings.push(...s.warnings);
  }
  if (config.process.tickets !== "markdown") {
    warnings.push(
      `Backlog written to .matrix/tickets (markdown); syncing it into ${config.process.tickets} needs that adapter.`,
    );
  }
  await mkdir(opts.outDir, { recursive: true });
  if ((await stat(opts.outDir)).isDirectory() === false)
    throw new Error(`${opts.outDir} is not a directory`);
  const written = await writeAll(opts.outDir, files);
  if (opts.scaffold && "biome.json" in files) {
    const formatted = formatWithBiome(opts.outDir);
    if (formatted) warnings.push(formatted);
  }
  const tickets = await seedBacklog(opts.outDir, config);
  return { status: "ok", config, answers, files: written, tickets, warnings, contradictions };
}
