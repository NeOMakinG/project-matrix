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

const BASE_ANSWERED: InitProgress["answered"] = [
  {
    questionId: "stack.web.framework",
    label: "Web framework",
    value: "React 19 + Vite",
    id: "stack.web.framework",
    pack: "Stack",
    prompt: "Web framework",
    kind: "select",
    rationale: "",
    recommended: "react-vite",
    options: [{ id: "react-vite", label: "React 19 + Vite", description: "", recommended: true }],
    dependsOn: [],
  },
  {
    questionId: "stack.web.router",
    label: "Routing",
    value: "TanStack Router (typed routes)",
    id: "stack.web.router",
    pack: "Stack",
    prompt: "Routing",
    kind: "select",
    rationale: "",
    recommended: "tanstack-router",
    options: [
      {
        id: "tanstack-router",
        label: "TanStack Router (typed routes)",
        description: "",
        recommended: true,
      },
    ],
    dependsOn: [],
  },
  {
    questionId: "stack.web.styling",
    label: "Styling",
    value: "Tailwind v4 + shadcn/ui",
    id: "stack.web.styling",
    pack: "Stack",
    prompt: "Styling",
    kind: "select",
    rationale: "",
    recommended: "tailwind-shadcn",
    options: [
      {
        id: "tailwind-shadcn",
        label: "Tailwind v4 + shadcn/ui",
        description: "",
        recommended: true,
      },
    ],
    dependsOn: [],
  },
];

export function makeProgress(answers: Record<string, string>): InitProgress {
  const answered: InitProgress["answered"] = [
    ...BASE_ANSWERED,
    ...QUESTIONS.filter((q) => answers[q.id]).map<InitProgress["answered"][number]>((q) => ({
      questionId: q.id,
      label: q.prompt,
      value: q.options.find((o) => o.id === answers[q.id])?.label ?? String(answers[q.id]),
      id: q.id,
      pack: q.pack,
      prompt: q.prompt,
      kind: "select",
      rationale: q.rationale,
      recommended: q.options.find((option) => option.recommended)?.id ?? null,
      options: q.options,
      dependsOn: [],
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
    // Mock server: the full round mirrors the single current question; no contradictions.
    round: question
      ? [
          {
            id: question.id,
            pack: question.pack,
            kind: "select" as const,
            prompt: question.prompt,
            rationale: question.rationale,
            recommended: question.options.find((o) => o.recommended)?.id ?? null,
            options: question.options,
            dependsOn: [],
          },
        ]
      : [],
    contradictions: [],
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
