import type { InitProgress } from "@/api/view";

type Question = NonNullable<InitProgress["question"]>;

const QUESTIONS: Question[] = [
  {
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
        description: "Typed end-to-end with your Node API, cache + optimistic updates.",
        recommended: true,
      },
      {
        id: "query-rest",
        label: "TanStack Query + REST (OpenAPI client)",
        description: "Language-neutral API, more boilerplate.",
        recommended: false,
      },
      {
        id: "swr",
        label: "SWR",
        description: "Lighter, fewer features for mutations and offline.",
        recommended: false,
      },
    ],
  },
  {
    id: "stack.web.forms",
    pack: "Stack",
    index: 8,
    total: 14,
    context: "web app",
    prompt: "Which form library should the web app use?",
    rationale: "Invoices and client records have long forms with validation shared with the API.",
    facts: "Facts found by agents: Zod is already chosen for schemas",
    options: [
      {
        id: "tanstack-form",
        label: "TanStack Form + Zod",
        description: "Type-safe, headless, shares Zod schemas.",
        recommended: true,
      },
      {
        id: "rhf",
        label: "React Hook Form + Zod",
        description: "Mature ecosystem, uncontrolled inputs.",
        recommended: false,
      },
    ],
  },
];

const BASE_ANSWERED = [
  { questionId: "stack.web.framework", label: "Web framework", value: "React 19 + Vite" },
  { questionId: "stack.web.router", label: "Routing", value: "TanStack Router (typed routes)" },
  { questionId: "stack.web.styling", label: "Styling", value: "Tailwind v4 + shadcn/ui" },
];

export function makeProgress(answers: Record<string, string>): InitProgress {
  const answered = [
    ...BASE_ANSWERED,
    ...QUESTIONS.filter((q) => answers[q.id]).map((q) => ({
      questionId: q.id,
      label: q.prompt,
      value: q.options.find((o) => o.id === answers[q.id])?.label ?? String(answers[q.id]),
    })),
  ];
  const question = QUESTIONS.find((q) => !answers[q.id]) ?? null;
  const stackAnswered = 6 + QUESTIONS.filter((q) => answers[q.id]).length;
  return {
    packs: [
      { id: "business", label: "Business", answered: 9, total: 9, state: "done" },
      { id: "product", label: "Product", answered: 7, total: 7, state: "done" },
      { id: "stack", label: "Stack", answered: stackAnswered, total: 14, state: "active" },
      { id: "hosting", label: "Hosting", answered: 0, total: 6, state: "todo" },
      { id: "design", label: "Design", answered: 0, total: 9, state: "todo" },
    ],
    answered,
    question,
    configPreview:
      'web: {\n  framework: "react-vite",\n  router: "tanstack-router",\n  ui: "shadcn", css: "tailwind-4",\n},\nautonomy: { merge: "human" },',
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
    ],
  };
}
