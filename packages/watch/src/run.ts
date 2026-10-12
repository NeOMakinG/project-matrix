import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TicketStore } from "@matrix/tickets";
import { collectArxiv, collectFeeds } from "./collectors/feeds.js";
import { collectGithubReleases, collectGithubTrending, githubRepo } from "./collectors/github.js";
import { collectHn } from "./collectors/hn.js";
import { collectOsv } from "./collectors/osv.js";
import {
  collectRegistryUpgrades,
  type RegistryInfo,
  registryInfo,
} from "./collectors/registries.js";
import { dedupe, SeenStore } from "./dedupe.js";
import { readDependencies } from "./deps.js";
import { fileProposals, isoWeek, relevant, renderDigest } from "./digest.js";
import type { HttpOptions } from "./http.js";
import type { GatewayConfig } from "./llm.js";
import { scoreItems } from "./score.js";
import type { ProjectContext, ScoredItem, WatchItem } from "./types.js";

export interface WatchOptions {
  root: string;
  context?: Partial<ProjectContext>;
  days?: number;
  feeds?: string[];
  arxivQuery?: string;
  languages?: string[];
  gateway?: GatewayConfig;
  tickets?: TicketStore;
  minRelevance?: number;
  maxDeps?: number;
  maxReleaseRepos?: number;
  http?: HttpOptions;
  /** Skip the "seen" filter (useful for previews). */
  includeSeen?: boolean;
  dryRun?: boolean;
  now?: () => Date;
  sources?: Partial<
    Record<"hn" | "feeds" | "arxiv" | "registry" | "releases" | "trending" | "osv", boolean>
  >;
}

export interface WatchResult {
  week: string;
  collected: number;
  fresh: number;
  scored: ScoredItem[];
  relevant: ScoredItem[];
  digest: string;
  digestPath?: string;
  tickets: string[];
  errors: { source: string; message: string }[];
}

export async function runWatch(opts: WatchOptions): Promise<WatchResult> {
  const now = (opts.now ?? (() => new Date()))();
  const days = opts.days ?? 7;
  const http = opts.http ?? {};
  const on = (s: keyof NonNullable<WatchOptions["sources"]>) => opts.sources?.[s] ?? true;
  const dependencies = opts.context?.dependencies ?? (await readDependencies(opts.root));
  const ctx: ProjectContext = {
    name: opts.context?.name ?? opts.root.split("/").filter(Boolean).at(-1) ?? "project",
    stack: opts.context?.stack ?? [],
    goals: opts.context?.goals ?? [],
    dependencies,
  };
  const deps = dependencies.slice(0, opts.maxDeps ?? 80);
  const errors: WatchResult["errors"] = [];
  const items: WatchItem[] = [];
  const attempt = async (source: string, fn: () => Promise<WatchItem[]>) => {
    try {
      items.push(...(await fn()));
    } catch (error) {
      errors.push({ source, message: (error as Error).message.slice(0, 200) });
    }
  };

  const infos = new Map<string, RegistryInfo | null>();
  if (on("registry") || on("releases")) {
    for (const dep of deps) {
      infos.set(`${dep.ecosystem}:${dep.name}`, await registryInfo(dep, http).catch(() => null));
    }
  }
  if (on("registry")) await attempt("registry", () => collectRegistryUpgrades(deps, http, infos));
  if (on("releases")) {
    const repos = deps
      .map((d) => ({
        dependency: d.name,
        repo: githubRepo(infos.get(`${d.ecosystem}:${d.name}`)?.repository),
      }))
      .filter((r): r is { dependency: string; repo: string } => Boolean(r.repo));
    const unique = [...new Map(repos.map((r) => [r.repo, r])).values()].slice(
      0,
      opts.maxReleaseRepos ?? 25,
    );
    await attempt("releases", () => collectGithubReleases(unique, days, http));
  }
  if (on("osv")) await attempt("osv", () => collectOsv(deps, http));
  if (on("hn") && ctx.stack.length) await attempt("hn", () => collectHn(ctx.stack, days, http));
  if (on("feeds") && opts.feeds?.length)
    await attempt("feeds", () => collectFeeds(opts.feeds!, days, http));
  if (on("arxiv") && opts.arxivQuery)
    await attempt("arxiv", () => collectArxiv(opts.arxivQuery!, 15, days, http));
  if (on("trending") && opts.languages?.length)
    await attempt("trending", () => collectGithubTrending(opts.languages!, http));

  const unique = dedupe(
    items.map((i) => ({
      ...i,
      title: i.title.replace(/\s+/g, " ").trim(),
      summary: i.summary.trim(),
    })),
  );
  const seenStore = new SeenStore(join(opts.root, ".matrix", "watch", "seen.json"));
  const seen = await seenStore.load();
  const fresh = opts.includeSeen ? unique : unique.filter((i) => !seen.has(i.id));
  const scored = await scoreItems(fresh, ctx, opts.gateway);
  const minRelevance = opts.minRelevance ?? 0.5;
  const week = isoWeek(now);
  const digest = renderDigest(ctx.name, week, scored, minRelevance);
  const result: WatchResult = {
    week,
    collected: items.length,
    fresh: fresh.length,
    scored,
    relevant: relevant(scored, minRelevance),
    digest,
    tickets: [],
    errors,
  };
  if (opts.dryRun) return result;

  const dir = join(opts.root, ".matrix", "watch");
  await mkdir(dir, { recursive: true });
  result.digestPath = join(dir, `digest-${week}.md`);
  await writeFile(result.digestPath, digest);
  if (opts.tickets) result.tickets = await fileProposals(opts.tickets, scored, minRelevance);
  for (const i of fresh) seen.add(i.id);
  await seenStore.save(seen);
  return result;
}
