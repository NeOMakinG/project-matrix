export function bookshopFiles(): Record<string, string> {
  const base = { schemaVersion: 1, scope: "Invented bookshop" };
  const documents = {
    "product-graph": {
      ...base,
      purpose: "Select books",
      nodes: [
        {
          id: "catalog",
          label: "Book catalog",
          kind: "feature",
          code: ["src/catalog.ts"],
          api: ["src/search.ts", "GET /books"],
          custom: { shelf: "fiction" },
        },
        { id: "basket", label: "Book basket", kind: "entity", references: ["docs/basket.md"] },
      ],
      edges: [{ from: "catalog", to: "basket", label: "adds-to" }],
      entityLifecycles: [{ id: "basket", states: ["empty", "filled"], actions: ["add-book"] }],
      journeys: [
        {
          id: "choose-book",
          persona: "reader",
          start: "Browse shelf",
          end: "Select a book",
          proof: ["src/catalog.test.ts"],
        },
      ],
      dataBoundaries: ["A basket belongs to its reader"],
    },
    personas: {
      ...base,
      evidencePolicy: "Fictional examples only",
      personas: [
        {
          id: "reader",
          name: "Book reader",
          basis: "Invented",
          job: "Find a novel",
          success: "Choose a book",
          contexts: ["At a desk"],
          expectations: ["Clear titles"],
          journeys: ["choose-book"],
        },
      ],
    },
    "ux-graph": {
      ...base,
      features: [
        {
          id: "shelf-ui",
          label: "Shelf browser",
          codeRoots: ["src"],
          runtimeInputs: ["book list"],
          bindings: ["shelf-selection"],
          entities: ["basket"],
        },
      ],
      states: [
        { id: "shelf-open", feature: "shelf-ui", label: "Shelf visible" },
        { id: "book-chosen", feature: "shelf-ui", label: "Book selected" },
      ],
      transitions: [{ from: "shelf-open", to: "book-chosen", event: "pick-book" }],
      bindings: [
        {
          id: "shelf-selection",
          feature: "shelf-ui",
          journey: "choose-book",
          personas: ["reader"],
          productNodes: ["catalog", "basket"],
          businessNodes: ["sales"],
          code: ["src/catalog.ts"],
          tests: ["src/catalog.test.ts"],
          cases: [
            { id: "pick-novel", description: "Choose an available novel", scopes: ["desktop"] },
          ],
          actions: ["select"],
        },
      ],
      evidencePolicy: "Demonstration",
    },
    "business-graph": {
      ...base,
      decisionPolicy: "Owner approval",
      nodes: [
        { id: "sales", label: "Book sales", kind: "goal" },
        { id: "inventory", label: "Stock", kind: "entity" },
      ],
      edges: [{ from: "inventory", to: "sales", label: "supports" }],
      candidateMetrics: [
        {
          id: "books-sold",
          definition: "Books sold per week",
          decisionState: "candidate",
          instrumentation: "Sales counter",
        },
      ],
      businessConstraints: ["Never sell unavailable books"],
      openDecisions: ["Shelf order"],
      evidence: ["Synthetic scenario"],
    },
  };
  return {
    "matrix.config.ts": `export default { knowledge: { productContext: { path: "docs/product-context", format: "product-context-v1" }, architectureGraph: { path: "docs/architecture/graph.json" } } };`,
    ...Object.fromEntries(
      Object.entries(documents).map(([name, data]) => [
        `docs/product-context/${name}.json`,
        JSON.stringify(data),
      ]),
    ),
    "docs/architecture/graph.json": JSON.stringify({
      nodes: [{ id: "store-app" }],
      edges: [],
      custom: "Read only",
    }),
    "src/catalog.ts": "export const catalog = [];\n",
    "src/search.ts": "export const search = () => [];\n",
    "src/catalog.test.ts":
      "import { catalog } from './catalog';\nexport const count = catalog.length;\n",
    "docs/basket.md": "# Book basket\n",
  };
}
