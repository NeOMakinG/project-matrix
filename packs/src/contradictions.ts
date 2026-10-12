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
];

export function findContradictions(answers: Answers): Contradiction[] {
  return contradictionRules
    .filter((r) => r.test(answers))
    .map(({ id, severity, message, questions }) => ({ id, severity, message, questions }));
}
