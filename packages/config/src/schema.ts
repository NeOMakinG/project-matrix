import { z } from "zod";

export const business = z.object({
  name: z.string().min(1),
  problem: z.string().min(1),
  targetCustomer: z.string().min(1),
  valueProposition: z.string().min(1),
  pricing: z.enum([
    "free",
    "freemium",
    "subscription",
    "usage-based",
    "one-time",
    "marketplace-fee",
    "undecided",
  ]),
  competitors: z.array(z.string()).default([]),
  distribution: z.array(
    z.enum([
      "seo",
      "content",
      "paid-ads",
      "social",
      "community",
      "sales-led",
      "partnerships",
      "app-stores",
      "product-led",
      "marketplaces",
    ]),
  ),
  successMetrics: z.array(z.string()).default([]),
});

export const product = z.object({
  personas: z.array(z.object({ name: z.string(), goal: z.string() })).min(1),
  coreFeatures: z.array(z.string()).min(1),
  mvpScope: z.array(z.string()).min(1),
  offlineFirst: z.boolean().default(false),
  multiTenant: z.boolean().default(false),
  syncStrategy: z.enum(["local-first", "cache-only", "none"]).optional(),
});

export const platform = z.enum(["web", "ios", "android", "desktop", "cli", "api-only"]);

export const reactStack = z.object({
  framework: z.literal("react"),
  bundler: z.enum(["vite", "tanstack-start", "next"]),
  router: z.enum(["tanstack-router", "react-router", "next-app-router"]),
  data: z.enum(["tanstack-query", "swr", "none"]),
  forms: z.enum(["tanstack-form", "react-hook-form", "none"]),
  tables: z.enum(["tanstack-table", "none"]),
  validation: z.literal("zod").default("zod"),
  api: z.enum(["trpc", "ts-rest", "openapi-fetch", "rest", "server-functions"]),
  effects: z.enum(["effect", "none"]),
  authzProofs: z.enum(["gdp-ts", "none"]),
  ui: z.enum(["shadcn", "mantine", "chakra", "custom"]),
  styling: z.enum(["tailwind", "css-modules", "vanilla-extract"]),
  motion: z.enum(["motion", "none"]),
  unitTests: z.literal("vitest").default("vitest"),
  e2e: z.enum(["playwright", "none"]),
  lint: z.enum(["biome", "eslint-prettier"]),
});

export const frontendStack = z.discriminatedUnion("framework", [
  reactStack,
  z.object({
    framework: z.literal("other"),
    name: z.string(),
    libraries: z.array(z.string()).default([]),
  }),
]);

export const mobileStack = z.object({
  framework: z.literal("expo"),
  router: z.literal("expo-router").default("expo-router"),
  data: z.enum(["tanstack-query", "none"]),
  styling: z.enum(["nativewind", "tamagui", "stylesheet"]),
  validation: z.literal("zod").default("zod"),
  builds: z.enum(["eas", "local"]),
  updates: z.enum(["eas-update", "none"]),
  qa: z.enum(["maestro", "agent-device", "orca"]),
});

export const desktopStack = z.object({
  framework: z.literal("tauri"),
  updater: z.boolean(),
  signing: z.array(z.enum(["macos", "windows"])).default([]),
  distribution: z.enum(["github-releases", "app-stores", "self-hosted"]),
});

export const goBackend = z.object({
  router: z.enum(["chi", "echo", "gin"]),
  data: z.enum(["sqlc", "ent", "gorm", "none"]),
  driver: z.enum(["pgx", "database-sql"]),
  logging: z.literal("slog").default("slog"),
  telemetry: z.enum(["opentelemetry", "none"]),
  lint: z.literal("golangci-lint").default("golangci-lint"),
});

export const backend = z.object({
  kind: z.enum(["node-api", "go", "fullstack", "none", "other"]),
  go: goBackend.optional(),
  runtime: z.enum(["bun", "node"]).optional(),
  framework: z.enum(["hono", "fastify", "elysia"]).optional(),
  database: z.enum(["postgres", "sqlite", "none"]),
  orm: z.enum(["drizzle", "prisma", "none"]),
  auth: z.enum(["better-auth", "clerk", "none"]),
  payments: z.enum(["stripe", "lemonsqueezy", "none"]),
  jobs: z.enum(["bullmq", "none"]),
  telemetry: z.enum(["opentelemetry", "none"]),
});

export const hosting = z.object({
  web: z.enum(["vercel", "cloudflare", "netlify", "fly", "railway", "self-hosted", "none"]),
  api: z.enum(["fly", "railway", "render", "aws", "cloudflare", "self-hosted", "none"]),
  database: z.enum(["neon", "supabase", "managed-by-host", "self-hosted", "none"]),
  environments: z.array(z.enum(["preview", "staging", "production"])).min(1),
});

export const observability = z.object({
  analytics: z.enum(["posthog", "plausible", "none"]),
  errors: z.enum(["sentry", "glitchtip", "posthog", "none"]),
  uptime: z.enum(["betterstack", "uptime-kuma", "none"]),
});

export const quality = z.object({
  coverageTarget: z.number().min(0).max(100),
  ci: z.enum(["github-actions", "gitlab-ci", "none"]),
  testStrategy: z.enum(["tdd", "test-after", "e2e-heavy"]),
});

export const phase = z.enum([
  "spike",
  "design",
  "implement",
  "checks",
  "review",
  "qa",
  "merge",
  "deploy",
  "verify",
]);
export const autonomyLevel = z.enum(["human", "gated-auto", "autonomous"]);

export const phaseModel = z.object({
  runner: z.enum(["claude-code", "codex", "opencode"]),
  model: z.string().min(1),
});

export const recommendedModels = {
  smallEstimateThreshold: 3,
  aliases: {},
  tiers: {
    large: { runner: "claude-code", model: "claude-opus-5-5" },
    small: { runner: "claude-code", model: "claude-sonnet-5-5" },
  },
  implement: { runner: "claude-code", model: "claude-opus-5-5" },
  spike: { runner: "claude-code", model: "claude-opus-5-5" },
  design: { runner: "claude-code", model: "claude-opus-5-5" },
  review: { runner: "codex", model: "gpt-6-sol" },
  qa: { runner: "codex", model: "gpt-6-sol" },
} as const;

export const modelsConfig = z.object({
  spike: phaseModel.optional(),
  design: phaseModel.optional(),
  checks: phaseModel.optional(),
  qa: phaseModel.optional(),
  merge: phaseModel.optional(),
  deploy: phaseModel.optional(),
  verify: phaseModel.optional(),
  implement: phaseModel.default(recommendedModels.implement),
  review: phaseModel.default(recommendedModels.review),
  tiers: z.object({ large: phaseModel, small: phaseModel }).optional(),
  smallEstimateThreshold: z.number().positive().default(3),
  aliases: z.record(z.string().min(1), z.string().min(1)).default({}),
});

/** Linear tracker settings. Holds the NAME of the host env var with the API key, never the key. */
export const linearTickets = z.object({
  teamKey: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/),
  projectLabel: z.string().min(1).max(80),
  readyState: z.string().min(1).max(80).default("Ready"),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/, "must be an env var name, not a key")
    // Only Linear-named vars: the value is sent to api.linear.app as the Authorization header.
    .regex(/^([A-Z0-9]+_)*LINEAR(_[A-Z0-9]+)*$/, "must be an env var name containing LINEAR")
    .default("LINEAR_API_KEY"),
});

export type LinearTicketsConfig = z.infer<typeof linearTickets>;

export const processConfig = z.object({
  disposableArtifacts: z.array(z.string().min(1)).optional(),
  tickets: z.enum(["beads", "github", "linear", "markdown"]),
  /** Required when `tickets` is "linear" (asked by the init interview). */
  linear: linearTickets.optional(),
  adrDir: z.string().default("docs/adr"),
  branching: z.enum(["trunk-with-prs", "gitflow"]),
  autonomy: z.object({
    merge: autonomyLevel,
    deploy: autonomyLevel,
    design: autonomyLevel.optional(),
  }),
  reviewLanes: z
    .array(z.enum(["correctness-security", "architecture-adr", "ux-product", "performance"]))
    .min(1),
  budgets: z.object({ dailyUsd: z.number().positive(), perTicketUsd: z.number().positive() }),
});

export const agentCapabilities = z
  .object({
    browserControl: z.boolean(),
    emulators: z.array(z.enum(["android", "ios"])).default([]),
    figmaMcp: z.boolean(),
    /** Only meaningful with the Figma MCP; defaults to false when Figma is off. */
    designFirst: z.boolean().default(false),
    browserDriver: z.enum(["agent-browser", "playwright", "orca-browser"]).optional(),
    emulatorDriver: z.enum(["orca", "agent-device", "maestro"]).optional(),
    extraClis: z.array(z.string()).default([]),
    workspace: z.enum(["orca", "native"]),
    /** Agent skills installed into the project (`.claude/skills`), derived from the stack. */
    skills: z.array(z.string()).default([]),
  })
  .refine((a) => !a.designFirst || a.figmaMcp, {
    message: "designFirst requires figmaMcp",
    path: ["designFirst"],
  });

export const design = z.object({
  componentLibrary: z.string().min(1).optional(),
  figmaFileUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        ["figma.com", "www.figma.com"].includes(url.hostname) &&
        /^\/(design|file)\/[a-zA-Z0-9]+(?:\/|$)/.test(url.pathname) &&
        !url.username &&
        !url.password
      );
    })
    .optional(),
  artDirection: z.string().min(1),
  theme: z.enum(["light", "dark", "both"]),
  brandColors: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
});

export const knowledgePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !/^(?:[\\/]|[a-zA-Z]:)/.test(value) &&
      !value.includes("\0") &&
      !value.split(/[\\/]/).includes(".."),
    "must be a repository-relative path without traversal",
  );

export const knowledge = z.object({
  productContext: z
    .object({ path: knowledgePath, format: z.literal("product-context-v1") })
    .optional(),
  architectureGraph: z.object({ path: knowledgePath }).optional(),
});

export const matrixConfig = z.object({
  version: z.literal(1),
  business,
  product,
  platforms: z.array(platform).min(1),
  frontend: frontendStack.optional(),
  mobile: mobileStack.optional(),
  desktop: desktopStack.optional(),
  backend,
  hosting,
  observability,
  quality,
  process: processConfig,
  agents: agentCapabilities,
  design,
  models: modelsConfig.default(recommendedModels),
  knowledge: knowledge.optional(),
});

export type MatrixConfig = z.infer<typeof matrixConfig>;
export type MatrixConfigInput = z.input<typeof matrixConfig>;
export type Phase = z.infer<typeof phase>;
export type AutonomyLevel = z.infer<typeof autonomyLevel>;

const providerQuota = z
  .object({
    maxConcurrent: z.number().int().min(1).max(64),
    maxRunsPerHour: z.number().int().min(1).max(10_000),
    maxRunnerMinutesPer5h: z.number().positive().max(100_000),
  })
  .partial()
  .strict();

/**
 * Factory-wide subscription quota guard (server env `MATRIX_QUOTA`, JSON). Providers are the
 * subscriptions runs draw on (`claude`, `codex`, ...); omitted values keep the safe defaults.
 */
export const quotaConfig = z
  .object({
    defaults: providerQuota.optional(),
    providers: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), providerQuota).optional(),
    cooldown: z
      .object({
        baseMs: z.number().int().min(1_000).max(3_600_000),
        maxMs: z
          .number()
          .int()
          .min(1_000)
          .max(24 * 3_600_000),
      })
      .partial()
      .strict()
      .optional(),
    perTicketRunnerMinutes: z.number().positive().max(100_000).optional(),
    maxRequeuesPerDay: z.number().int().min(0).max(50).optional(),
  })
  .strict();

export type QuotaConfig = z.infer<typeof quotaConfig>;
