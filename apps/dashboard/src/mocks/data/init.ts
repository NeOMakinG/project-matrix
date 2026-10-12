import type { InitSession } from "@/api/schemas";

const packs: InitSession["packs"] = [
  { id: "business", label: "Business", answered: 9, total: 9, state: "done" },
  { id: "product", label: "Product", answered: 7, total: 7, state: "done" },
  { id: "platforms", label: "Platforms", answered: 3, total: 3, state: "done" },
  { id: "stack", label: "Stack", answered: 6, total: 14, state: "active" },
  { id: "backend", label: "Backend", answered: 0, total: 11, state: "todo" },
  { id: "hosting", label: "Hosting", answered: 0, total: 6, state: "todo" },
  { id: "observability", label: "Observability", answered: 0, total: 5, state: "todo" },
  { id: "quality", label: "Quality", answered: 0, total: 7, state: "todo" },
  { id: "process", label: "Process", answered: 0, total: 8, state: "todo" },
  { id: "agents", label: "Agent capabilities", answered: 0, total: 6, state: "todo" },
  { id: "design", label: "Design", answered: 0, total: 9, state: "todo" },
];

export function makeInitSession(): InitSession {
  return {
    id: "init_ledgerly",
    projectName: "ledgerly",
    answersCount: 38,
    packs: structuredClone(packs),
    currentPack: "Stack",
    answered: [
      { label: "Web framework", value: "React 19 + Vite" },
      { label: "Routing", value: "TanStack Router (typed routes)" },
      { label: "Styling", value: "Tailwind v4 + shadcn/ui" },
      { label: "Schemas", value: "Zod everywhere" },
      { label: "Forms", value: "TanStack Form + Zod" },
      { label: "Tables", value: "TanStack Table" },
    ],
    question: {
      id: "stack.web.data",
      pack: "Stack",
      index: 7,
      total: 14,
      context: "web app",
      prompt: "How should the web app fetch and cache server data?",
      rationale:
        "Ledgerly shows invoices, clients and payments that change from several places (webhooks, other devices). You need caching, background refetch and optimistic updates for marking invoices paid.",
      facts: "Facts found by agents: API is Node + tRPC-ready (Backend pack draft)",
      options: [
        {
          id: "query-trpc",
          label: "TanStack Query + tRPC",
          description:
            "Typed end-to-end with your Node API, cache + optimistic updates, matches ADR-0003 (TypeScript everywhere).",
          recommended: true,
        },
        {
          id: "query-rest",
          label: "TanStack Query + REST (OpenAPI client)",
          description:
            "Language-neutral API, more boilerplate, good if third parties call the API.",
          recommended: false,
        },
        {
          id: "swr",
          label: "SWR",
          description: "Lighter, fewer features for mutations and offline.",
          recommended: false,
        },
        {
          id: "loaders",
          label: "Loaders only (no client cache)",
          description: "Simplest; weak for live updates.",
          recommended: false,
        },
      ],
    },
    configPreview: `web: {
  framework: "react-vite",
  router: "tanstack-router",
  data: "tanstack-query+trpc",
  ui: "shadcn", css: "tailwind-4",
  forms: "tanstack-form", schema: "zod",
},
analytics: "posthog",
autonomy: { merge: "human" },`,
    adrs: [
      {
        id: "0001",
        title: "Invoicing SaaS for freelancers (business)",
        status: { label: "accepted", tone: "green" },
      },
      {
        id: "0004",
        title: "Web: React + Vite + TanStack Router",
        status: { label: "accepted", tone: "green" },
      },
      { id: "0007", title: "Payments via Stripe", status: { label: "accepted", tone: "green" } },
      {
        id: "0011",
        title: "Money as integer cents",
        status: { label: "accepted · 2 rules", tone: "green" },
      },
      {
        id: "0012",
        title: "Server state: TanStack Query + tRPC",
        status: { label: "proposed", tone: "blue" },
      },
    ],
  };
}
