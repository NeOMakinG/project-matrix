import type { Answers } from "./types";

/** A realistic sample business used by tests and the QA receipt. */
export const sampleAnswers: Answers = {
  "business.name": "Ledgerly",
  "business.problem": "Freelancers lose hours every month chasing unpaid invoices.",
  "business.targetCustomer": "Independent consultants and 1-10 person agencies in the EU",
  "business.valueProposition":
    "Invoices that chase themselves: reminders, payment links and late fees on autopilot.",
  "business.pricing": "subscription",
  "business.competitors": "FreshBooks, Invoice Ninja, Excel",
  "business.distribution": ["seo", "content", "product-led", "community"],
  "product.personas": "Freelancer: get paid on time; Agency owner: see cash flow at a glance",
  "product.coreFeatures":
    "invoices, automatic reminders, payment links, client portal, cash-flow dashboard",
  "platforms.targets": ["web"],
};
