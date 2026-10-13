import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import type { MatrixConfig } from "@matrix/config";
import { linkTicket, loadProductGraph, saveProductGraph, writeGraph } from "@matrix/graph";
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
import { suggestDisposableArtifacts } from "@matrix/packs/disposable";
import { MarkdownTicketStore } from "@matrix/tickets/adapters/markdown";
import { assertSafePath } from "@matrix/tickets/adapters/safe-fs";
import { trackedArtifactFiles } from "./disposable-artifacts";
import { planWrites, SafePathError, safeWrite } from "./fs-safe";
import {
  adrPath,
  configFile,
  contextFile,
  type Files,
  productGraph,
  recordAdr,
  renderAdr,
  slug,
} from "./generate/docs";
import { scaffoldFiles } from "./generate/scaffold";
import { skillFiles, skillsFor } from "./generate/skills";

export interface InitOptions {
  answers: Answers;
  outDir: string;
  acceptRecommended: boolean;
  scaffold: boolean;
  /** Pre-fill answers from an existing repository. */
  existingRepo?: string;
  /** Replace existing files (never symlinks). Without it, init refuses to overwrite. */
  force?: boolean;
  packs?: Pack[];
  date?: string;
}

export type InitResult =
  | { status: "missing"; missing: Question[] }
  | { status: "contradictions"; contradictions: Contradiction[] }
  | { status: "invalid"; issues: { path: string; message: string }[] }
  | { status: "conflicts"; files: string[] }
  | {
      status: "ok";
      config: MatrixConfig;
      answers: Answers;
      files: string[];
      skipped: string[];
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

/**
 * Plans ADR files against what is already in the ADR folder: ADRs generated earlier (matched by
 * their `Source: matrix init (question)` line) keep their number and path, new decisions are
 * numbered after the highest existing ADR, and the "record decisions" ADR is only added to an
 * empty folder.
 */
async function planAdrs(
  outDir: string,
  adrDir: string,
  ds: ReturnType<typeof decisions>,
  date: string,
): Promise<{ files: Files; numbers: Map<string, number> }> {
  const known = new Map<string, { n: number; path: string }>();
  let max = 0;
  let hasRecord = false;
  let entries: string[] = [];
  try {
    entries = await readdir(join(outDir, adrDir));
  } catch {
    entries = [];
  }
  for (const f of entries) {
    const n = Number(/^(\d{4})-.*\.md$/.exec(f)?.[1] ?? Number.NaN);
    if (Number.isNaN(n)) continue;
    max = Math.max(max, n);
    if (f.includes("record-architecture-decisions")) hasRecord = true;
    const source = /Source: `matrix init` \(([^)]+)\)/.exec(
      await readFile(join(outDir, adrDir, f), "utf8"),
    );
    if (source?.[1]) known.set(source[1], { n, path: `${adrDir}/${f}` });
  }
  const files: Files = {};
  const numbers = new Map<string, number>();
  let next = max + 1;
  if (max === 0 && !hasRecord) {
    files[adrPath(next, "record architecture decisions", adrDir)] = recordAdr(next, date);
    next++;
  }
  for (const d of ds) {
    const prior = known.get(d.questionId);
    const n = prior?.n ?? next++;
    numbers.set(d.questionId, n);
    files[prior?.path ?? adrPath(n, d.topic, adrDir)] = renderAdr(d, n, date);
  }
  return { files, numbers };
}

interface SeededBacklog {
  ids: string[];
  /** Feature tickets and the product-graph feature they implement. */
  features: { id: string; title: string; feature: string }[];
}

async function seedBacklog(outDir: string, config: MatrixConfig): Promise<SeededBacklog> {
  const root = await realpath(outDir);
  const store = new MarkdownTicketStore(join(root, ".matrix/tickets"), { root });
  const existing = new Map((await store.list()).map((t) => [t.title, t]));
  const create: typeof store.create = async (input) =>
    existing.get(input.title) ?? (await store.create(input));
  const setup = await create({
    title: "Bootstrap repository and CI",
    body: "Install dependencies and commit `bun.lock` (CI installs with `--frozen-lockfile`), make `typecheck`, `lint` and `test` pass, and keep the generated CI workflow green.",
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
    const t = await create({ title, body, labels: ["setup"], priority: 2, deps: [setup.id] });
    ids.push(t.id);
  }
  const features: SeededBacklog["features"] = [];
  for (const feature of config.product.mvpScope) {
    const t = await create({
      title: `Feature: ${feature}`,
      body: `MVP feature for ${config.product.personas.map((p) => p.name).join(", ")}.\n\nSpike first: plan, affected ADRs and test plan.`,
      labels: ["feature", "mvp"],
      priority: 2,
      deps: [setup.id],
    });
    ids.push(t.id);
    features.push({ id: t.id, title: t.title, feature: `feature:${slug(feature)}` });
  }
  return { ids, features };
}

/** Links feature tickets to the product-graph features they implement. */
async function linkBacklog(outDir: string, backlog: SeededBacklog): Promise<void> {
  const graph = await loadProductGraph(outDir);
  const known = new Set(graph.nodes.map((n) => n.id));
  for (const t of backlog.features)
    linkTicket(graph, { id: t.id, title: t.title }, known.has(t.feature) ? [t.feature] : []);
  await saveProductGraph(outDir, graph);
}

/** Formats the generated project with the factory's own Biome so it passes `lint` out of the box. */
function formatWithBiome(dir: string, files: string[]): string | null {
  const targets = files.filter(
    (f) => /\.(tsx?|jsx?|json|css)$/.test(f) && !f.startsWith(".matrix/"),
  );
  if (targets.length === 0) return null;
  const bin = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
  const r = spawnSync(process.execPath, [bin, "check", "--write", ...targets], {
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
  const skills = skillsFor(built.config);
  const config: MatrixConfig = { ...built.config, agents: { ...built.config.agents, skills } };

  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const ds = decisions(packs, answers);
  await mkdir(opts.outDir, { recursive: true });
  if (!(await stat(opts.outDir)).isDirectory())
    throw new Error(`${opts.outDir} is not a directory`);
  const existingMode = opts.existingRepo !== undefined;
  const scaffold = opts.scaffold ? scaffoldFiles(config) : undefined;
  const artifactFiles = {
    ...scaffold?.files,
    ...(await trackedArtifactFiles(opts.existingRepo ?? opts.outDir)),
  };
  config.process = {
    ...config.process,
    disposableArtifacts: [
      ...new Set([
        ...(config.process.disposableArtifacts ?? []),
        ...suggestDisposableArtifacts(artifactFiles),
      ]),
    ].sort(),
  };

  const adrs = await planAdrs(opts.outDir, config.process.adrDir, ds, date);

  let files: Files = {
    "matrix.config.ts": configFile(config),
    ".matrix/answers.json": `${JSON.stringify(answers, null, 2)}\n`,
    "CONTEXT.md": contextFile(config),
    ".matrix/graph/product.json": productGraph(config, ds, adrs.numbers),
    // Fail-closed floor for `matrix check`: rules may only shrink through a reviewed change.
    ".matrix/rules-manifest.json": `${JSON.stringify(
      {
        version: 1,
        adrDir: "docs/adr",
        minRules: ds.reduce((n, d) => n + d.rules.filter((r) => r.check).length, 0),
      },
      null,
      2,
    )}\n`,
    ...adrs.files,
    ...(await skillFiles(skills)),
  };
  const warnings: string[] = [];
  if (scaffold) {
    files = { ...scaffold.files, ...files };
    warnings.push(...scaffold.warnings);
  }
  warnings.push(
    "Review process.disposableArtifacts in the onboarding PR before trusting the new config as BASE.",
  );

  // The backlog is written by the ticket store; refuse unsafe backlog paths before writing anything.
  const root = await realpath(opts.outDir);
  await assertSafePath(root, join(root, ".matrix/tickets/.ids/x"));
  const plan = await planWrites(opts.outDir, Object.keys(files));
  if (plan.refused.length > 0) {
    throw new SafePathError(
      `refusing to write: ${plan.refused.map((r) => `${r.path} (${r.reason})`).join(", ")}`,
    );
  }
  if (existingMode && plan.existing.includes("CONTEXT.md")) {
    // An existing glossary is the user's; ours goes next to it for a manual merge.
    files[".matrix/CONTEXT.generated.md"] = files["CONTEXT.md"] as string;
    delete files["CONTEXT.md"];
    warnings.push(
      "CONTEXT.md already exists; the generated one is in .matrix/CONTEXT.generated.md to merge.",
    );
  }
  if (!existingMode && plan.existing.length > 0 && !opts.force) {
    return { status: "conflicts", files: plan.existing.filter((f) => f in files) };
  }

  const { written, skipped } = await safeWrite(opts.outDir, files, {
    overwrite: !existingMode && opts.force === true,
  });
  if (skipped.length > 0)
    warnings.push(`Kept ${skipped.length} existing file(s): ${skipped.join(", ")}`);
  if (config.process.tickets !== "markdown") {
    warnings.push(
      `Backlog written to .matrix/tickets (markdown); syncing it into ${config.process.tickets} needs that adapter.`,
    );
  }
  if (opts.scaffold && written.includes("biome.json")) {
    const formatted = formatWithBiome(opts.outDir, written);
    if (formatted) warnings.push(formatted);
  }
  const backlog = await seedBacklog(opts.outDir, config);
  await linkBacklog(opts.outDir, backlog);
  if (opts.scaffold) await writeGraph(opts.outDir);
  return {
    status: "ok",
    config,
    answers,
    files: written,
    skipped,
    tickets: backlog.ids,
    warnings,
    contradictions,
  };
}
