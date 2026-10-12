import type { Pack } from "../types";
import { list, opt } from "./helpers";

const personas = (v: unknown) =>
  list(v as string).map((entry) => {
    const [name, ...goal] = entry.split(/[:—-]/);
    return { name: (name ?? entry).trim(), goal: goal.join("-").trim() || "uses the product" };
  });

export const productPack: Pack = {
  id: "product",
  title: "Product",
  questions: [
    {
      id: "product.personas",
      pack: "product",
      kind: "list",
      field: "product.personas",
      prompt: "Personas as 'Name: goal', separated by ';'?",
      rationale: "Review lanes compare behaviour against these goals.",
      toValue: personas,
    },
    {
      id: "product.coreFeatures",
      pack: "product",
      kind: "list",
      field: "product.coreFeatures",
      prompt: "Core features (comma-separated)?",
      toValue: list,
    },
    {
      id: "product.mvpScope",
      pack: "product",
      kind: "list",
      field: "product.mvpScope",
      prompt: "Which features are in the MVP (comma-separated)?",
      dependsOn: ["product.coreFeatures"],
      recommended: (a) => list(a["product.coreFeatures"] ?? []).slice(0, 3),
      rationale: "Three features is usually enough to test the value proposition.",
      toValue: list,
    },
    {
      id: "product.multiTenant",
      pack: "product",
      kind: "confirm",
      field: "product.multiTenant",
      prompt: "Do several organisations share one deployment (multi-tenant)?",
      recommended: true,
      adr: {
        topic: "tenancy model",
        context: "Tenancy decides data isolation, auth scopes and billing granularity.",
      },
    },
    {
      id: "product.offlineFirst",
      pack: "product",
      kind: "confirm",
      field: "product.offlineFirst",
      prompt: "Must it work offline (offline-first)?",
      recommended: false,
    },
    {
      id: "product.syncStrategy",
      pack: "product",
      kind: "select",
      field: "product.syncStrategy",
      prompt: "How does offline data sync?",
      when: (a) => a["product.offlineFirst"] === true,
      recommended: "local-first",
      options: [
        opt("local-first", "Local database + background sync", "Real offline writes."),
        opt("cache-only", "Read cache only", "Offline reads, writes need the network."),
        opt("none", "No sync yet"),
      ],
      adr: {
        topic: "offline sync strategy",
        context: "Offline-first changes the data layer, conflict handling and tests.",
      },
    },
  ],
};
