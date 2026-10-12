import { z } from "zod";

export const ECOSYSTEMS = ["npm", "crates", "pypi"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  /** Version range or pin as declared; `resolved` is the concrete version when a lockfile tells us. */
  version: string;
  resolved?: string;
}

export const SOURCES = [
  "hn",
  "github-release",
  "github-trending",
  "feed",
  "arxiv",
  "registry",
  "osv",
] as const;
export type WatchSource = (typeof SOURCES)[number];

export const WatchItemSchema = z.object({
  id: z.string(),
  source: z.enum(SOURCES),
  title: z.string(),
  url: z.string(),
  summary: z.string().default(""),
  publishedAt: z.string().optional(),
  dependency: z.string().optional(),
  version: z.string().optional(),
  severity: z.enum(["low", "moderate", "high", "critical"]).optional(),
});
export type WatchItem = z.infer<typeof WatchItemSchema>;

export const KINDS = ["upgrade", "idea", "risk", "ignore"] as const;
export type ProposalKind = (typeof KINDS)[number];

export const ScoreSchema = z.object({
  id: z.string(),
  relevance: z.number().min(0).max(1),
  kind: z.enum(KINDS),
  rationale: z.string(),
  action: z.string(),
});
export type Score = z.infer<typeof ScoreSchema>;

export const ScoreBatchSchema = z.object({ scores: z.array(ScoreSchema) });

export interface ScoredItem extends WatchItem {
  score: Score;
}

export interface ProjectContext {
  name: string;
  /** Free-text stack keywords, e.g. from matrix.config (react, tanstack, hono, drizzle, postgres). */
  stack: string[];
  /** Product goals or features from the product graph, used for "idea" relevance. */
  goals: string[];
  dependencies: Dependency[];
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
