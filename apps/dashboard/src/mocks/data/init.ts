import type { InitProgress } from "@/api/view";

type Question = NonNullable<InitProgress["question"]> & InitProgress["round"][number];

const QUESTIONS: Question[] = [
  {
    id: "business.name",
    pack: "Business",
    index: 1,
    total: 3,
    context: "business",
    prompt: "Product name?",
    rationale: "Name the product.",
    facts: "",
    options: [],
    kind: "text",
    recommended: null,
    dependsOn: [],
  },
  {
    id: "stack.web.data",
    kind: "select",
    recommended: "query-trpc",
    dependsOn: [],
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
    kind: "select",
    recommended: "tanstack-form",
    dependsOn: [],
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

const CONFIRMED_QUESTIONS: InitProgress["round"] = [
  {
    id: "backend.orm",
    pack: "backend",
    kind: "select",
    prompt: "backend.orm",
    rationale: "Keep SQL visible and types exact.",
    recommended: "drizzle",
    dependsOn: [],
    options: [
      { id: "drizzle", label: "Drizzle", description: "Typed SQL.", recommended: true },
      { id: "none", label: "None", description: "No ORM.", recommended: false },
    ],
  },
  {
    id: "hosting.api",
    pack: "hosting",
    kind: "select",
    prompt: "hosting.api",
    rationale: "Choose API hosting.",
    recommended: "fly",
    dependsOn: ["backend.orm"],
    options: [
      { id: "fly", label: "Fly", description: "Managed hosting.", recommended: true },
      { id: "none", label: "None", description: "No hosting.", recommended: false },
    ],
  },
  {
    id: "process.reviewLanes",
    pack: "process",
    kind: "multiselect",
    prompt: "Review lanes on every change?",
    rationale: "Each lane reviews a different concern.",
    recommended: ["correctness-security"],
    dependsOn: [],
    options: [
      {
        id: "correctness-security",
        label: "Correctness + security",
        description: "Review correctness and security.",
        recommended: true,
      },
      {
        id: "architecture-adr",
        label: "Architecture / ADR",
        description: "Review architecture.",
        recommended: false,
      },
    ],
  },
  {
    id: "business.goals",
    pack: "business",
    kind: "list",
    prompt: "Business goals?",
    rationale: "Describe success.",
    recommended: null,
    dependsOn: [],
    options: [],
  },
];

export function makeProgress(answers: Record<string, unknown>): InitProgress {
  // Mirrors the server: one row per stored answer, keyed by question id.
  const answered = [...QUESTIONS, ...CONFIRMED_QUESTIONS]
    .filter((question) => question.id in answers)
    .map((question) => {
      const raw = answers[question.id];
      const values = Array.isArray(raw) ? raw : [String(raw)];
      return {
        id: question.id,
        pack: question.pack,
        kind: question.kind,
        prompt: question.prompt,
        rationale: question.rationale,
        recommended: question.recommended,
        options: question.options,
        dependsOn: question.dependsOn,
        questionId: question.id,
        label: question.prompt,
        value: values
          .map((value) => question.options.find((option) => option.id === value)?.label ?? value)
          .join(", "),
      };
    });
  const question = QUESTIONS.find((question) => !(question.id in answers)) ?? null;
  const stackAnswered = 6 + QUESTIONS.filter((question) => question.id in answers).length;
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
            kind: question.kind,
            prompt: question.prompt,
            rationale: question.rationale,
            recommended: question.recommended,
            options: question.options,
            dependsOn: question.dependsOn,
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
