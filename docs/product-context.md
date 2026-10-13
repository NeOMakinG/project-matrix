# External product knowledge

Existing projects can keep a richer product-context directory as their source of truth:

```ts
export default {
  knowledge: {
    productContext: {
      path: "docs/product-context",
      format: "product-context-v1",
    },
    architectureGraph: { path: "docs/architecture/graph.json" },
  },
};
```

`product-context-v1` reads four JSON documents with `schemaVersion: 1`:

- `product-graph.json`: nodes (`id`, `kind`, `label`), edges (`from`, `to`, `label`), entity lifecycles, journeys and data boundaries.
- `personas.json`: personas with names, jobs, success criteria, expectations and journey references.
- `ux-graph.json`: features, states, transitions and bindings connecting personas, product nodes, business nodes, code and tests.
- `business-graph.json`: nodes, edges, candidate metrics, constraints, open decisions and evidence.

Known fields are Zod-validated; additional fields remain available in node data and graph context. Matrix preserves product IDs and namespaces supplemental nodes. Declared code, code roots, references, journey proof and test paths create module links for impact queries. Relative filenames in `api` are linked too; HTTP routes and URLs remain metadata. Paths are repository-relative and cannot traverse directories or follow symlinks. Each document is limited to 4 MiB, collections to 10,000 elements and nesting to 32 levels. Missing or invalid configured documents fail closed; Matrix does not fall back to its generated product graph.

`matrix init --existing` preserves configured external sources and detects the conventional four-file directory. It does not generate `.matrix/graph/product.json` or write ticket links into external knowledge. Non-interactive answers can also set `knowledge.productContext.path`, `knowledge.productContext.format`, and `knowledge.architectureGraph.path`. Existing configuration is preserved except for adding or updating the knowledge settings when needed. Keep knowledge settings as literal objects (optionally through local constants or `defineConfig`); Matrix reads them statically without executing project code. Dynamic expressions and root spreads are rejected.

`matrix graph query impact`, graph validation, `matrix check`, and server knowledge reads use the adapter. External graph writes through `saveProductGraph` are refused. The optional architecture JSON is returned as `architecture: { path, readOnly: true, graph }` in knowledge output. It is a bounded JSON object reference only: it neither replaces nor regenerates Matrix's `.matrix/graph/code.json`.

## Read-only and safety guarantees

Neither adapter writes to its source directory. Reading knowledge and onboarding leave the external JSON documents unchanged; configured product context also prevents creation of `.matrix/graph/product.json`. Existing copies of that Matrix artifact are ignored, not deleted. Matrix still owns and regenerates its separate code graph.

Both adapters refuse symlinked source files and directory components, including links outside the repository. Architecture references use the same 4 MiB file, 10,000-element collection, 65,536-character string and 32-level nesting bounds as product context. Unsafe, missing or oversized configured sources cause validation to fail rather than silently selecting another source.
