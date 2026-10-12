import type { Answers } from "./types";

export interface Contradiction {
  id: string;
  severity: "error" | "warning";
  message: string;
  /** Questions to re-ask to resolve it. */
  questions: string[];
}

interface Rule {
  id: string;
  severity: Contradiction["severity"];
  message: string;
  questions: string[];
  test: (a: Answers) => boolean;
}

const has = (a: Answers, id: string, value: string): boolean => {
  const v = a[id];
  return Array.isArray(v) ? v.includes(value) : v === value;
};

const noBackend = (a: Answers) => a["backend.kind"] === "none";

export const contradictionRules: Rule[] = [
  {
    id: "offline-without-sync",
    severity: "error",
    message:
      "Offline-first was requested but there is no sync strategy, so offline writes would be lost.",
    questions: ["product.offlineFirst", "product.syncStrategy"],
    test: (a) => a["product.offlineFirst"] === true && a["product.syncStrategy"] === "none",
  },
  {
    id: "payments-without-backend",
    severity: "error",
    message: "Payments need a server to verify webhooks, but no backend was chosen.",
    questions: ["backend.kind", "backend.payments"],
    test: (a) =>
      noBackend(a) && a["backend.payments"] !== undefined && a["backend.payments"] !== "none",
  },
  {
    id: "self-hosted-auth-without-backend",
    severity: "error",
    message: "better-auth stores sessions in your database, but there is no backend.",
    questions: ["backend.kind", "backend.auth"],
    test: (a) => noBackend(a) && a["backend.auth"] === "better-auth",
  },
  {
    id: "orm-without-database",
    severity: "error",
    message: "An ORM was chosen without a database.",
    questions: ["backend.database", "backend.orm"],
    test: (a) =>
      a["backend.database"] === "none" &&
      a["backend.orm"] !== undefined &&
      a["backend.orm"] !== "none",
  },
  {
    id: "multitenant-without-auth",
    severity: "error",
    message: "Multi-tenant products need authentication to isolate organisations.",
    questions: ["product.multiTenant", "backend.auth"],
    test: (a) => a["product.multiTenant"] === true && a["backend.auth"] === "none",
  },
  {
    id: "deploy-more-autonomous-than-merge",
    severity: "error",
    message: "Deploys can't be more autonomous than merges: unmerged code would never deploy.",
    questions: ["process.autonomy.merge", "process.autonomy.deploy"],
    test: (a) => {
      const rank = { human: 0, "gated-auto": 1, autonomous: 2 } as Record<string, number>;
      return (
        (rank[String(a["process.autonomy.deploy"])] ?? 0) >
        (rank[String(a["process.autonomy.merge"])] ?? 0)
      );
    },
  },
  {
    id: "paid-without-payments",
    severity: "warning",
    message: "The pricing model charges customers but no payment provider was chosen.",
    questions: ["business.pricing", "backend.payments"],
    test: (a) =>
      ["subscription", "usage-based", "one-time", "marketplace-fee"].includes(
        String(a["business.pricing"]),
      ) && a["backend.payments"] === "none",
  },
  {
    id: "web-qa-without-browser",
    severity: "warning",
    message: "Web QA receipts need browser control, which agents are not allowed.",
    questions: ["agents.browserControl"],
    test: (a) => has(a, "platforms.targets", "web") && a["agents.browserControl"] === false,
  },
  {
    id: "app-stores-without-mobile",
    severity: "warning",
    message: "App stores are a distribution channel but no mobile platform ships first.",
    questions: ["business.distribution", "platforms.targets"],
    test: (a) =>
      has(a, "business.distribution", "app-stores") &&
      !has(a, "platforms.targets", "ios") &&
      !has(a, "platforms.targets", "android"),
  },
  {
    id: "next-without-app-router",
    severity: "error",
    message: "Next.js routes through its App Router; another router cannot own the URLs.",
    questions: ["frontend.bundler", "frontend.router"],
    test: (a) => a["frontend.bundler"] === "next" && a["frontend.router"] !== "next-app-router",
  },
  {
    id: "app-router-without-next",
    severity: "error",
    message: "The Next.js App Router only exists inside Next.js.",
    questions: ["frontend.bundler", "frontend.router"],
    test: (a) => a["frontend.router"] === "next-app-router" && a["frontend.bundler"] !== "next",
  },
  {
    id: "start-without-tanstack-router",
    severity: "error",
    message: "TanStack Start is built on TanStack Router.",
    questions: ["frontend.bundler", "frontend.router"],
    test: (a) =>
      a["frontend.bundler"] === "tanstack-start" && a["frontend.router"] !== "tanstack-router",
  },
  {
    id: "server-functions-without-fullstack",
    severity: "error",
    message:
      "Server functions need a full-stack framework (Next.js or TanStack Start), not a Vite SPA.",
    questions: ["frontend.bundler", "frontend.api"],
    test: (a) =>
      a["frontend.api"] === "server-functions" &&
      a["frontend.bundler"] !== "next" &&
      a["frontend.bundler"] !== "tanstack-start",
  },
  {
    id: "fullstack-without-framework",
    severity: "error",
    message: "A full-stack backend needs Next.js or TanStack Start on the web.",
    questions: ["backend.kind", "frontend.bundler"],
    test: (a) =>
      a["backend.kind"] === "fullstack" &&
      a["frontend.bundler"] !== "next" &&
      a["frontend.bundler"] !== "tanstack-start",
  },
  {
    id: "trpc-with-go",
    severity: "error",
    message: "tRPC needs a TypeScript server; a Go API should publish an OpenAPI contract.",
    questions: ["backend.kind", "frontend.api"],
    test: (a) => a["backend.kind"] === "go" && a["frontend.api"] === "trpc",
  },
  {
    id: "ts-library-with-go",
    severity: "error",
    message:
      "better-auth, Drizzle and Prisma are TypeScript libraries; they cannot run in a Go API.",
    questions: ["backend.kind", "backend.auth", "backend.orm"],
    test: (a) =>
      a["backend.kind"] === "go" &&
      (a["backend.auth"] === "better-auth" ||
        a["backend.orm"] === "drizzle" ||
        a["backend.orm"] === "prisma"),
  },
  {
    id: "store-distribution-unsigned",
    severity: "error",
    message: "The Mac App Store and Microsoft Store only accept signed builds.",
    questions: ["desktop.distribution", "desktop.signing"],
    test: (a) =>
      a["desktop.distribution"] === "app-stores" &&
      !(Array.isArray(a["desktop.signing"]) && a["desktop.signing"].length > 0),
  },
  {
    id: "updater-unsigned",
    severity: "warning",
    message:
      "Auto-updates without OS code signing still work, but users get security warnings on every install.",
    questions: ["desktop.updater", "desktop.signing"],
    test: (a) =>
      a["desktop.updater"] === true &&
      !(Array.isArray(a["desktop.signing"]) && a["desktop.signing"].length > 0),
  },
  {
    id: "orca-driver-without-orca",
    severity: "warning",
    message: "Orca's browser and emulators are only available when runs live in Orca worktrees.",
    questions: ["agents.workspace", "agents.browserDriver", "agents.emulatorDriver"],
    test: (a) =>
      a["agents.workspace"] === "native" &&
      (a["agents.browserDriver"] === "orca-browser" || a["agents.emulatorDriver"] === "orca"),
  },
];

export function findContradictions(answers: Answers): Contradiction[] {
  return contradictionRules
    .filter((r) => r.test(answers))
    .map(({ id, severity, message, questions }) => ({ id, severity, message, questions }));
}
