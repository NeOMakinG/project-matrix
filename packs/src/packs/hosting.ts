import type { Pack } from "../types";
import { hasBackend, hasWebUi, opt } from "./helpers";

export const hostingPack: Pack = {
  id: "hosting",
  title: "Hosting",
  questions: [
    {
      id: "hosting.web",
      pack: "hosting",
      kind: "select",
      field: "hosting.web",
      prompt: "Where is the web frontend hosted?",
      dependsOn: ["platforms.targets"],
      recommended: (a) => (hasWebUi(a) ? "cloudflare" : "none"),
      rationale: "Cloudflare Pages: global CDN, preview deploys, generous free tier.",
      options: [
        opt("cloudflare", "Cloudflare"),
        opt("vercel", "Vercel"),
        opt("netlify", "Netlify"),
        opt("fly", "Fly.io"),
        opt("railway", "Railway"),
        opt("self-hosted", "Self-hosted"),
        opt("none", "None"),
      ],
      adr: {
        topic: "web hosting",
        context: "Hosting sets preview environments, edge behaviour and costs.",
      },
    },
    {
      id: "hosting.api",
      pack: "hosting",
      kind: "select",
      field: "hosting.api",
      prompt: "Where does the API run?",
      dependsOn: ["backend.kind"],
      recommended: (a) => (hasBackend(a) ? "fly" : "none"),
      rationale: "Fly runs Bun/Node containers close to users with simple rollbacks.",
      options: [
        opt("fly", "Fly.io"),
        opt("railway", "Railway"),
        opt("render", "Render"),
        opt("aws", "AWS"),
        opt("cloudflare", "Cloudflare Workers"),
        opt("self-hosted", "Self-hosted"),
        opt("none", "None"),
      ],
      adr: {
        topic: "API hosting",
        context: "API hosting decides deploy pipelines, scaling and regions.",
      },
    },
    {
      id: "hosting.database",
      pack: "hosting",
      kind: "select",
      field: "hosting.database",
      prompt: "Where does the database live?",
      dependsOn: ["backend.database"],
      recommended: (a) =>
        a["backend.database"] === "postgres"
          ? "neon"
          : a["backend.database"] === "none"
            ? "none"
            : "managed-by-host",
      rationale: "Neon: serverless Postgres with branch-per-preview environments.",
      options: [
        opt("neon", "Neon"),
        opt("supabase", "Supabase"),
        opt("managed-by-host", "Managed by the API host"),
        opt("self-hosted", "Self-hosted"),
        opt("none", "None"),
      ],
    },
    {
      id: "hosting.environments",
      pack: "hosting",
      kind: "multiselect",
      field: "hosting.environments",
      prompt: "Environments?",
      recommended: ["preview", "production"],
      rationale: "A preview per PR gives QA a real URL; add staging when releases need sign-off.",
      options: [
        opt("preview", "Preview per PR"),
        opt("staging", "Staging"),
        opt("production", "Production"),
      ],
    },
  ],
};
