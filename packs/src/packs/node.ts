import type { Answers, Option, Pack, Question, RuleStub } from "../types";
import { hasBackend, hasGoBackend, hasServer, opt } from "./helpers";

interface Choice {
  key: string;
  prompt: string;
  options: Option[];
  recommended: string | ((a: Answers) => string);
  rationale: string;
  detect?: Record<string, string>;
  topic: string;
  context: string;
  when?: (a: Answers) => boolean;
  rules?: (value: string) => RuleStub[];
}

const choice = (c: Choice): Question => ({
  id: `backend.${c.key}`,
  pack: "backend",
  kind: "select",
  field: `backend.${c.key}`,
  prompt: c.prompt,
  options: c.options,
  recommended: c.recommended,
  rationale: c.rationale,
  dependsOn: ["backend.kind"],
  when: c.when ?? hasBackend,
  ...(c.detect
    ? {
        infer: (ctx) => {
          for (const [value, pkg] of Object.entries(c.detect ?? {})) {
            if (ctx.dependencies.has(pkg)) return value;
          }
          return undefined;
        },
      }
    : {}),
  adr: {
    topic: c.topic,
    context: c.context,
    ...(c.rules ? { rules: (v) => c.rules?.(String(v)) ?? [] } : {}),
  },
});

const noneUnlessBackend = (fallback: string) => (a: Answers) => (hasServer(a) ? fallback : "none");

export const nodePack: Pack = {
  id: "backend",
  title: "Backend (Node API)",
  questions: [
    {
      id: "backend.kind",
      pack: "backend",
      kind: "select",
      field: "backend.kind",
      prompt: "Backend?",
      dependsOn: ["platforms.targets"],
      recommended: "node-api",
      rationale: "A TypeScript API shares types and validation with the frontend.",
      options: [
        opt("node-api", "TypeScript API (Bun/Node)"),
        opt("go", "Go API", "Static binary, low memory, strong concurrency."),
        opt("none", "No backend (static, BaaS, or full-stack framework routes)"),
        opt("other", "Other (Python… packs coming)"),
      ],
      infer: (ctx) =>
        ["hono", "fastify", "elysia", "express"].some((p) => ctx.dependencies.has(p))
          ? "node-api"
          : ctx.files.has("go.mod") || ctx.files.has("services/api/go.mod")
            ? "go"
            : undefined,
      adr: {
        topic: "backend",
        context: "The backend shape decides deployment, auth and data ownership.",
      },
    },
    choice({
      key: "runtime",
      prompt: "Runtime?",
      options: [
        opt("bun", "Bun", "Fast startup, built-in test runner and SQLite."),
        opt("node", "Node.js", "Most compatible."),
      ],
      recommended: "bun",
      rationale: "Matches the factory's own runtime; Node stays available for compatibility.",
      topic: "server runtime",
      context: "The runtime affects hosting support and native dependencies.",
    }),
    choice({
      key: "framework",
      prompt: "HTTP framework?",
      options: [
        opt("hono", "Hono", "Runs on Bun, Node, Cloudflare and Vercel; tiny and typed."),
        opt("fastify", "Fastify", "Mature Node ecosystem."),
        opt("elysia", "Elysia", "Bun-native, end-to-end types."),
      ],
      recommended: "hono",
      rationale: "Portable across every hosting option in the next pack.",
      detect: { hono: "hono", fastify: "fastify", elysia: "elysia" },
      topic: "HTTP framework",
      context: "The framework sets middleware, validation and portability.",
    }),
    choice({
      key: "database",
      prompt: "Database?",
      options: [opt("postgres", "Postgres"), opt("sqlite", "SQLite / libSQL"), opt("none", "None")],
      recommended: noneUnlessBackend("postgres"),
      rationale: "Postgres covers relational, JSON and full-text needs as the product grows.",
      detect: { postgres: "postgres", sqlite: "@libsql/client" },
      topic: "database",
      context: "The database choice drives hosting, migrations and local development.",
      when: () => true,
    }),
    choice({
      key: "orm",
      prompt: "ORM / query builder?",
      options: [
        opt("drizzle", "Drizzle", "SQL-like, typed, light."),
        opt("prisma", "Prisma"),
        opt("none", "None"),
      ],
      recommended: (a) =>
        a["backend.database"] === "none" || hasGoBackend(a) ? "none" : "drizzle",
      rationale: "Drizzle keeps SQL visible and types exact.",
      detect: { drizzle: "drizzle-orm", prisma: "@prisma/client" },
      topic: "ORM",
      context: "Data access must go through one layer so agents don't scatter raw SQL.",
      when: () => true,
      rules: (v) =>
        v === "drizzle" || v === "prisma"
          ? [
              {
                engine: "dependency-cruiser",
                description: `Only src/db may import ${v === "drizzle" ? "drizzle-orm" : "@prisma/client"}.`,
                pattern: v === "drizzle" ? "^drizzle-orm" : "^@prisma/client",
                check: {
                  type: "forbidden-import",
                  files: ["apps/api/src/**"],
                  except: ["apps/api/src/db/**"],
                  import: v === "drizzle" ? "^drizzle-orm" : "^@prisma/client",
                },
              },
              {
                engine: "dependency-cruiser",
                description: `One ORM: ${v === "drizzle" ? "Prisma" : "Drizzle"} must not be added next to ${v}.`,
                check: {
                  type: "forbidden-import",
                  files: ["apps/**"],
                  import: v === "drizzle" ? "^@prisma/client" : "^drizzle-orm",
                },
              },
            ]
          : [],
    }),
    choice({
      key: "auth",
      prompt: "Authentication?",
      options: [
        opt("better-auth", "better-auth", "Self-hosted, TypeScript-first."),
        opt("clerk", "Clerk", "Hosted."),
        opt("none", "None"),
      ],
      recommended: (a) => (hasBackend(a) ? "better-auth" : hasGoBackend(a) ? "clerk" : "none"),
      rationale:
        "better-auth keeps user data in your own database (TypeScript only); a Go API verifies Clerk sessions with its Go SDK.",
      detect: { "better-auth": "better-auth", clerk: "@clerk/backend" },
      topic: "authentication",
      context: "Auth sets session handling, user data location and tenancy checks.",
      when: () => true,
    }),
    choice({
      key: "payments",
      prompt: "Payments?",
      options: [
        opt("stripe", "Stripe"),
        opt("lemonsqueezy", "Lemon Squeezy", "Merchant of record, handles VAT."),
        opt("none", "None"),
      ],
      recommended: (a) => (a["business.pricing"] === "free" || !hasServer(a) ? "none" : "stripe"),
      rationale: "Stripe for subscriptions and usage billing.",
      detect: { stripe: "stripe" },
      topic: "payments",
      context: "Billing touches entitlements, webhooks and tax.",
      when: () => true,
    }),
    choice({
      key: "jobs",
      prompt: "Background jobs?",
      options: [opt("bullmq", "BullMQ (Redis)"), opt("none", "None yet")],
      recommended: "none",
      rationale: "Add a queue when the first slow or scheduled task appears.",
      detect: { bullmq: "bullmq" },
      topic: "background jobs",
      context: "Jobs need retries, idempotency and monitoring.",
      when: () => true,
    }),
    choice({
      key: "telemetry",
      prompt: "Tracing and metrics?",
      options: [opt("opentelemetry", "OpenTelemetry"), opt("none", "None")],
      recommended: noneUnlessBackend("opentelemetry"),
      rationale: "The prod loop reads traces to find root causes.",
      detect: { opentelemetry: "@opentelemetry/api" },
      topic: "telemetry",
      context: "Traces feed the factory's monitor and autofix loop.",
      when: () => true,
    }),
  ],
};
