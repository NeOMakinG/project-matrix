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
  "implement",
  "checks",
  "review",
  "qa",
  "merge",
  "deploy",
  "verify",
]);
export const autonomyLevel = z.enum(["human", "gated-auto", "autonomous"]);

export const processConfig = z.object({
  tickets: z.enum(["beads", "github", "linear", "markdown"]),
  adrDir: z.string().default("docs/adr"),
  branching: z.enum(["trunk-with-prs", "gitflow"]),
  autonomy: z.object({ merge: autonomyLevel, deploy: autonomyLevel }),
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
  artDirection: z.string().min(1),
  theme: z.enum(["light", "dark", "both"]),
  brandColors: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
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
});

export type MatrixConfig = z.infer<typeof matrixConfig>;
export type MatrixConfigInput = z.input<typeof matrixConfig>;
export type Phase = z.infer<typeof phase>;
export type AutonomyLevel = z.infer<typeof autonomyLevel>;
