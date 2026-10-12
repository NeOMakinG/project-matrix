import type { Pack } from "../types";
import { opt } from "./helpers";

export const observabilityPack: Pack = {
  id: "observability",
  title: "Analytics and monitoring",
  questions: [
    {
      id: "observability.analytics",
      pack: "observability",
      kind: "select",
      field: "observability.analytics",
      prompt: "Product analytics?",
      recommended: "posthog",
      rationale: "PostHog covers events, funnels, feature flags and session replay in one tool.",
      options: [
        opt("posthog", "PostHog"),
        opt("plausible", "Plausible (privacy-first page analytics)"),
        opt("none", "None"),
      ],
      infer: (ctx) => (ctx.dependencies.has("posthog-js") ? "posthog" : undefined),
      adr: {
        topic: "product analytics",
        context: "Analytics events measure the business success metrics.",
      },
    },
    {
      id: "observability.errors",
      pack: "observability",
      kind: "select",
      field: "observability.errors",
      prompt: "Error tracking (feeds the factory's autofix loop)?",
      recommended: "sentry",
      rationale:
        "Sentry has the best stack traces and release tracking; GlitchTip is the self-hosted, Sentry-compatible option.",
      options: [
        opt("sentry", "Sentry"),
        opt("glitchtip", "GlitchTip (self-hosted)"),
        opt("posthog", "PostHog error tracking"),
        opt("none", "None"),
      ],
      infer: (ctx) =>
        ctx.dependencies.has("@sentry/react") || ctx.dependencies.has("@sentry/node")
          ? "sentry"
          : undefined,
      adr: {
        topic: "error tracking",
        context: "Errors become tickets automatically in the prod loop.",
      },
    },
    {
      id: "observability.uptime",
      pack: "observability",
      kind: "select",
      field: "observability.uptime",
      prompt: "Uptime checks?",
      recommended: "betterstack",
      options: [
        opt("betterstack", "Better Stack"),
        opt("uptime-kuma", "Uptime Kuma (self-hosted)"),
        opt("none", "None"),
      ],
    },
  ],
};
