import type { Answers, Option, Pack, Question, RuleStub } from "../types";
import { hasGoBackend, hasWebUi, opt, usesReact } from "./helpers";

interface LibQuestion {
  key: string;
  prompt: string;
  options: Option[];
  recommended: string | ((a: Answers) => string);
  rationale: string;
  /** npm package that reveals each option in an existing repo. */
  detect?: Record<string, string>;
  topic: string;
  context: string;
  rules?: (value: string) => RuleStub[];
}

const lib = (q: LibQuestion): Question => ({
  id: `frontend.${q.key}`,
  pack: "frontend",
  kind: "select",
  field: `frontend.${q.key}`,
  prompt: q.prompt,
  options: q.options,
  recommended: q.recommended,
  rationale: q.rationale,
  dependsOn: ["frontend.framework"],
  when: usesReact,
  ...(q.detect
    ? {
        infer: (ctx) => {
          for (const [value, pkg] of Object.entries(q.detect ?? {})) {
            if (ctx.dependencies.has(pkg)) return value;
          }
          return undefined;
        },
      }
    : {}),
  adr: {
    topic: q.topic,
    context: q.context,
    ...(q.rules ? { rules: (v) => q.rules?.(String(v)) ?? [] } : {}),
  },
});

export const reactPack: Pack = {
  id: "frontend",
  title: "Frontend (React)",
  questions: [
    {
      id: "frontend.framework",
      pack: "frontend",
      kind: "select",
      field: "frontend.framework",
      prompt: "Frontend framework?",
      when: hasWebUi,
      dependsOn: ["platforms.targets"],
      recommended: "react",
      rationale: "React has the deepest library ecosystem and the richest factory pack.",
      options: [opt("react", "React"), opt("other", "Other (named next)")],
      infer: (ctx) => (ctx.dependencies.has("react") ? "react" : undefined),
      adr: {
        topic: "frontend framework",
        context: "The framework picks the stack pack, lint rules and QA drivers.",
      },
    },
    {
      id: "frontend.name",
      pack: "frontend",
      kind: "text",
      field: "frontend.name",
      prompt: "Which framework then (e.g. svelte, vue, solid)?",
      dependsOn: ["frontend.framework"],
      when: (a) => hasWebUi(a) && a["frontend.framework"] === "other",
    },
    lib({
      key: "bundler",
      prompt: "App framework / bundler?",
      options: [
        opt("vite", "Vite SPA", "Simplest; pairs with a separate API."),
        opt("tanstack-start", "TanStack Start", "Full-stack, type-safe server functions, SSR."),
        opt("next", "Next.js", "SSR/SEO heavy marketing + app."),
      ],
      recommended: (a) => (a["backend.kind"] === "fullstack" ? "tanstack-start" : "vite"),
      rationale:
        "A Vite SPA plus a typed API keeps frontend and backend independently deployable; a full-stack backend needs Next.js or TanStack Start.",
      detect: { "tanstack-start": "@tanstack/react-start", next: "next", vite: "vite" },
      topic: "app framework and bundler",
      context: "Decides rendering mode (SPA/SSR), routing options and hosting targets.",
    }),
    lib({
      key: "router",
      prompt: "Router?",
      options: [
        opt("tanstack-router", "TanStack Router", "Fully typed routes, search params and loaders."),
        opt("react-router", "React Router"),
        opt("next-app-router", "Next.js App Router"),
      ],
      recommended: (a) =>
        a["frontend.bundler"] === "next" ? "next-app-router" : "tanstack-router",
      rationale:
        "Type-safe routes and search params catch broken links at compile time; Next.js brings its own App Router.",
      detect: { "tanstack-router": "@tanstack/react-router", "react-router": "react-router" },
      topic: "routing",
      context: "Routing defines URL structure, data loading and code splitting.",
      rules: (v) =>
        v === "tanstack-router"
          ? [
              {
                engine: "dependency-cruiser",
                description: "Routes use TanStack Router; react-router must not come back in.",
                check: {
                  type: "forbidden-import",
                  files: ["apps/web/src/**"],
                  import: "^react-router(-dom)?(/|$)",
                },
              },
            ]
          : v === "next-app-router"
            ? [
                {
                  engine: "dependency-cruiser",
                  description:
                    "Routes are Next.js App Router files; no client-side router library.",
                  check: {
                    type: "forbidden-import",
                    files: ["apps/web/**"],
                    import: "^(react-router(-dom)?|@tanstack/react-router)(/|$)",
                  },
                },
              ]
            : [],
    }),
    lib({
      key: "data",
      prompt: "Server state / data fetching?",
      options: [
        opt("tanstack-query", "TanStack Query", "Caching, retries, invalidation, devtools."),
        opt("swr", "SWR"),
        opt("none", "Plain fetch"),
      ],
      recommended: "tanstack-query",
      rationale: "One cache layer avoids ad-hoc fetch + useEffect bugs.",
      detect: { "tanstack-query": "@tanstack/react-query", swr: "swr" },
      topic: "server state management",
      context: "Server state needs caching, deduplication and invalidation rules.",
      rules: (v) =>
        v === "tanstack-query"
          ? [
              {
                engine: "ast-grep",
                description: "No fetch() inside components; use query hooks from src/api.",
                pattern: "fetch($$$)",
                check: {
                  type: "call-pattern",
                  files: ["apps/web/src/**"],
                  except: ["apps/web/src/api/**"],
                  pattern: "fetch($$$)",
                },
              },
              {
                engine: "dependency-cruiser",
                description: "Server state goes through TanStack Query, not SWR or axios.",
                check: {
                  type: "forbidden-import",
                  files: ["apps/web/src/**"],
                  import: "^(swr|axios)(/|$)",
                },
              },
            ]
          : [],
    }),
    lib({
      key: "forms",
      prompt: "Forms?",
      options: [
        opt("tanstack-form", "TanStack Form"),
        opt("react-hook-form", "React Hook Form"),
        opt("none", "None"),
      ],
      recommended: "tanstack-form",
      rationale: "Typed fields with Zod validators share schemas with the API.",
      detect: { "tanstack-form": "@tanstack/react-form", "react-hook-form": "react-hook-form" },
      topic: "forms",
      context: "Forms need validation shared with the API contract.",
      rules: (v) =>
        v === "tanstack-form"
          ? [
              {
                engine: "dependency-cruiser",
                description: "Forms use TanStack Form with Zod validators; no second form library.",
                check: {
                  type: "forbidden-import",
                  files: ["apps/web/src/**"],
                  import: "^(react-hook-form|formik)(/|$)",
                },
              },
            ]
          : [],
    }),
    lib({
      key: "tables",
      prompt: "Data tables?",
      options: [opt("tanstack-table", "TanStack Table"), opt("none", "None")],
      recommended: "tanstack-table",
      rationale: "Headless, typed sorting/filtering/pagination for admin-style screens.",
      detect: { "tanstack-table": "@tanstack/react-table" },
      topic: "data tables",
      context: "Most business apps need sortable, filterable lists.",
    }),
    lib({
      key: "api",
      prompt: "API contract between frontend and backend?",
      options: [
        opt("trpc", "tRPC", "End-to-end types, no codegen, best with a TS backend."),
        opt("ts-rest", "ts-rest", "Typed REST contract, OpenAPI friendly."),
        opt("openapi-fetch", "OpenAPI + openapi-fetch", "For non-TS or public APIs."),
        opt("rest", "Plain REST"),
        opt(
          "server-functions",
          "Framework server functions",
          "TanStack Start server functions / Next.js server actions: typed, no separate API.",
        ),
      ],
      recommended: (a) =>
        hasGoBackend(a)
          ? "openapi-fetch"
          : a["backend.kind"] === "fullstack"
            ? "server-functions"
            : "trpc",
      rationale:
        "tRPC for a TypeScript API, OpenAPI for a Go API, framework server functions when the full-stack framework is the backend.",
      detect: {
        trpc: "@trpc/client",
        "ts-rest": "@ts-rest/core",
        "openapi-fetch": "openapi-fetch",
      },
      topic: "API contract",
      context: "The contract decides how types flow between client and server.",
      rules: (v) =>
        v === "trpc"
          ? [
              {
                engine: "dependency-cruiser",
                description:
                  "The web app reaches the API only through the tRPC client; it may import the router type, never server code.",
                check: {
                  type: "boundary",
                  files: ["apps/web/src/**"],
                  disallow: ["apps/api/**"],
                },
              },
            ]
          : [],
    }),
    lib({
      key: "effects",
      prompt: "Use Effect for domain logic (typed errors, services)?",
      options: [
        opt("effect", "Effect", "Typed errors and dependency injection for real domain logic."),
        opt("none", "No"),
      ],
      recommended: "none",
      rationale: "Worth it when domain logic is rich; plain TS + Zod is simpler for CRUD apps.",
      detect: { effect: "effect" },
      topic: "domain logic style",
      context: "Effect changes how errors, retries and dependencies are modelled.",
    }),
    lib({
      key: "authzProofs",
      prompt: "Compile-time authorization proofs (gdp-ts)?",
      options: [
        opt("gdp-ts", "gdp-ts", "Code that skips an auth check doesn't compile."),
        opt("none", "No"),
      ],
      recommended: "gdp-ts",
      rationale: "'Forgot to check permissions' becomes a type error instead of a security bug.",
      detect: { "gdp-ts": "@gdp-ts/core" },
      topic: "authorization proofs",
      context: "Authorization checks are easy to forget in handlers and loaders.",
    }),
    lib({
      key: "ui",
      prompt: "UI component library?",
      options: [
        opt("shadcn", "shadcn/ui (Radix)"),
        opt("mantine", "Mantine"),
        opt("chakra", "Chakra UI"),
        opt("custom", "Custom"),
      ],
      recommended: "shadcn",
      rationale: "Owned components on accessible Radix primitives, easy to theme.",
      detect: {
        shadcn: "@radix-ui/react-slot",
        mantine: "@mantine/core",
        chakra: "@chakra-ui/react",
      },
      topic: "UI component library",
      context: "The component library sets accessibility, theming and design consistency.",
    }),
    lib({
      key: "styling",
      prompt: "Styling?",
      options: [
        opt("tailwind", "Tailwind CSS v4"),
        opt("css-modules", "CSS Modules"),
        opt("vanilla-extract", "vanilla-extract"),
      ],
      recommended: "tailwind",
      rationale: "Pairs with shadcn/ui and keeps styles next to markup.",
      detect: { tailwind: "tailwindcss", "vanilla-extract": "@vanilla-extract/css" },
      topic: "styling",
      context: "Styling approach affects theming, bundle size and agent edit patterns.",
    }),
    lib({
      key: "motion",
      prompt: "Animation library?",
      options: [opt("motion", "Motion"), opt("none", "None")],
      recommended: "motion",
      rationale: "Small, declarative transitions improve perceived quality.",
      detect: { motion: "motion" },
      topic: "animation",
      context: "Animations need one consistent library and reduced-motion support.",
    }),
    lib({
      key: "e2e",
      prompt: "End-to-end tests?",
      options: [
        opt("playwright", "Playwright", "Also produces QA screenshots and videos."),
        opt("none", "None"),
      ],
      recommended: "playwright",
      rationale: "The QA phase reuses Playwright for receipts.",
      detect: { playwright: "@playwright/test" },
      topic: "end-to-end testing",
      context: "E2E tests are the QA phase's main evidence for web apps.",
    }),
    lib({
      key: "lint",
      prompt: "Lint and format?",
      options: [
        opt("biome", "Biome", "One fast tool for lint + format."),
        opt("eslint-prettier", "ESLint + Prettier", "Largest plugin ecosystem."),
      ],
      recommended: "biome",
      rationale: "Fast enough to run on every agent edit.",
      detect: { biome: "@biomejs/biome", "eslint-prettier": "eslint" },
      topic: "linting and formatting",
      context: "Lint runs in the checks phase after every implementation step.",
    }),
  ],
};
