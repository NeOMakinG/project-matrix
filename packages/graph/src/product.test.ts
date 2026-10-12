import { describe, expect, test } from "vitest";
import { buildCodeGraph } from "./code";
import {
  emptyProductGraph,
  link,
  linkModule,
  linkTicket,
  loadProductGraph,
  parseProductGraph,
  saveProductGraph,
  upsertNode,
} from "./product";
import {
  adrsGoverning,
  dependenciesOf,
  dependents,
  featuresForTicket,
  impactOfFile,
  importersOf,
  importersOfPackage,
} from "./queries";
import { fixtureProject } from "./test-utils";

const seed = () => {
  const g = emptyProductGraph();
  upsertNode(g, { id: "goal:problem", kind: "goal", label: "Get paid on time" });
  upsertNode(g, { id: "feature:invoices", kind: "feature", label: "invoices" });
  upsertNode(g, { id: "feature:reminders", kind: "feature", label: "reminders" });
  upsertNode(g, { id: "adr:0023", kind: "decision", label: "ORM: Drizzle" });
  link(g, "feature:invoices", "goal:problem", "solves");
  return g;
};

describe("product graph", () => {
  test("accepts the graph matrix init writes", () => {
    const g = parseProductGraph({
      version: 1,
      nodes: [
        { id: "goal:problem", kind: "goal", label: "p" },
        { id: "metric:x", kind: "metric", label: "x" },
        { id: "adr:0002", kind: "decision", label: "pricing" },
      ],
      edges: [{ from: "goal:problem", to: "metric:x", kind: "measured-by" }],
    });
    expect(g.nodes).toHaveLength(3);
  });

  test("rejects dangling edges and duplicate ids", () => {
    expect(() =>
      parseProductGraph({
        version: 1,
        nodes: [
          { id: "a", kind: "goal", label: "a" },
          { id: "a", kind: "goal", label: "b" },
        ],
        edges: [{ from: "a", to: "ghost", kind: "has" }],
      }),
    ).toThrow(/duplicate a[\s\S]*unknown node ghost/);
  });

  test("links are idempotent and saved graphs round-trip", async () => {
    const g = seed();
    linkTicket(g, { id: "T-0005", title: "Invoices" }, ["feature:invoices"]);
    linkTicket(g, { id: "T-0005", title: "Invoices" }, ["feature:invoices"]);
    linkModule(g, "apps/api/src/invoices", ["feature:invoices"]);
    expect(g.edges.filter((e) => e.kind === "implements")).toHaveLength(1);
    expect(() => link(g, "ticket:T-0005", "feature:nope", "implements")).toThrow(/feature:nope/);
    const root = await fixtureProject({});
    await saveProductGraph(root, g);
    expect(await loadProductGraph(root)).toEqual(g);
  });
});

describe("queries", () => {
  test("who imports what, dependents and impact", async () => {
    const root = await fixtureProject({
      "apps/api/src/db/client.ts":
        'import { drizzle } from "drizzle-orm/node-postgres";\nexport const db = drizzle("");\n',
      "apps/api/src/invoices/service.ts":
        'import { db } from "../db/client";\nexport const list = () => db;\n',
      "apps/api/src/router.ts":
        'import { list } from "./invoices/service";\nexport const r = list;\n',
    });
    const code = await buildCodeGraph(root);
    expect(importersOf(code, "apps/api/src/db/client.ts")).toEqual([
      { path: "apps/api/src/invoices/service.ts", line: 1 },
    ]);
    expect(importersOfPackage(code, "drizzle-orm")).toEqual([
      { path: "apps/api/src/db/client.ts", line: 1 },
    ]);
    expect(dependenciesOf(code, "apps/api/src/router.ts")).toEqual([
      "apps/api/src/invoices/service.ts",
    ]);
    expect(dependents(code, "apps/api/src/db/client.ts")).toEqual([
      "apps/api/src/db/client.ts",
      "apps/api/src/invoices/service.ts",
      "apps/api/src/router.ts",
    ]);

    const product = seed();
    linkModule(product, "apps/api/src/invoices", ["feature:invoices"]);
    upsertNode(product, { id: "module:apps/api/src/db", kind: "module", label: "apps/api/src/db" });
    link(product, "adr:0023", "module:apps/api/src/db", "governs");
    const scopes = [
      { adr: "adr:0024", files: ["apps/api/src/**"], except: ["apps/api/src/db/**"] },
    ];

    expect(adrsGoverning("apps/api/src/db/client.ts", scopes, product)).toEqual(["adr:0023"]);
    expect(adrsGoverning("apps/api/src/router.ts", scopes, product)).toEqual(["adr:0024"]);

    const impact = impactOfFile("apps/api/src/db/client.ts", { code, product, adrScopes: scopes });
    expect(impact.features.map((f) => f.id)).toEqual(["feature:invoices"]);
    expect(impact.adrs).toEqual(["adr:0023", "adr:0024"]);
  });

  test("features touched by a ticket, directly or through modules", () => {
    const g = seed();
    linkTicket(g, { id: "T-1", title: "Invoice list" }, ["feature:invoices"]);
    linkModule(g, "apps/web/src/reminders", ["feature:reminders"]);
    link(g, "ticket:T-1", "module:apps/web/src/reminders", "touches");
    expect(
      featuresForTicket(g, "T-1")
        .map((f) => f.id)
        .sort(),
    ).toEqual(["feature:invoices", "feature:reminders"]);
  });
});
