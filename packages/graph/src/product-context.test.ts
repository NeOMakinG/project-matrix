import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildCodeGraph } from "./code";
import { readKnowledgeConfig } from "./knowledge";
import { loadProductGraph, saveProductGraph } from "./product";
import { bookshopFiles } from "./product-context.fixture";
import { featuresForPath, impactOfFile } from "./queries";
import { fixtureProject } from "./test-utils";

describe("external product context", () => {
  test("reads and refused writes leave both external source directories unchanged", async () => {
    const files = bookshopFiles();
    const root = await fixtureProject(files);
    const productFiles = await readdir(join(root, "docs/product-context"));
    const architectureFiles = await readdir(join(root, "docs/architecture"));
    const graph = await loadProductGraph(root);
    await expect(saveProductGraph(root, graph)).rejects.toThrow("read-only");
    expect(await readdir(join(root, "docs/product-context"))).toEqual(productFiles);
    expect(await readdir(join(root, "docs/architecture"))).toEqual(architectureFiles);
    for (const [path, contents] of Object.entries(files))
      if (path.startsWith("docs/")) expect(await readFile(join(root, path), "utf8")).toBe(contents);
    await expect(readFile(join(root, ".matrix/graph/product.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("architecture references enforce byte, collection and depth bounds", async () => {
    for (const extra of [
      "a".repeat(4 * 1024 * 1024),
      Array(10001).fill(1),
      Array.from({ length: 34 }).reduce((value) => ({ value }), {}),
    ]) {
      const files = bookshopFiles();
      const path = "docs/architecture/graph.json";
      files[path] = JSON.stringify({ extra });
      const root = await fixtureProject(files);
      await expect(loadProductGraph(root)).rejects.toThrow();
      expect(await readFile(join(root, path), "utf8")).toBe(files[path]);
    }
  });

  test("maps all sources, retains rich data and ignores a stale local graph", async () => {
    const root = await fixtureProject({
      ...bookshopFiles(),
      ".matrix/graph/product.json": "invalid",
    });
    const graph = await loadProductGraph(root);
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "catalog",
          kind: "feature",
          data: expect.objectContaining({ custom: { shelf: "fiction" } }),
        }),
        expect.objectContaining({ id: "persona:reader", kind: "persona" }),
        expect.objectContaining({
          id: "lifecycle:basket",
          data: expect.objectContaining({ states: ["empty", "filled"] }),
        }),
        expect.objectContaining({ id: "ux:binding:shelf-selection", kind: "ux" }),
        expect.objectContaining({ id: "business:sales", kind: "goal" }),
        expect.objectContaining({ id: "metric:books-sold", kind: "metric" }),
      ]),
    );
    expect(graph.edges).toContainEqual({
      from: "ux:state:shelf-open",
      to: "ux:state:book-chosen",
      kind: "pick-book",
    });
    expect(graph.context?.product).toMatchObject({
      dataBoundaries: ["A basket belongs to its reader"],
    });
    expect(graph.architecture).toMatchObject({
      path: "docs/architecture/graph.json",
      readOnly: true,
    });
    expect(featuresForPath(graph, "src/catalog.ts").map((node) => node.id)).toContain("catalog");
    expect(featuresForPath(graph, "src/search.ts").map((node) => node.id)).toContain("catalog");
    expect(graph.nodes.some((node) => node.label === "GET /books")).toBe(false);
    expect(
      impactOfFile("src/catalog.ts", {
        code: await buildCodeGraph(root),
        product: graph,
      }).features.map((node) => node.id),
    ).toContain("basket");
    await expect(saveProductGraph(root, graph)).rejects.toThrow("read-only");
    expect(await readFile(join(root, ".matrix/graph/product.json"), "utf8")).toBe("invalid");
  });

  test.each(["product-graph", "personas", "ux-graph", "business-graph"])(
    "fails closed for a missing %s file",
    async (name) => {
      const files = bookshopFiles();
      delete files[`docs/product-context/${name}.json`];
      await expect(loadProductGraph(await fixtureProject(files))).rejects.toThrow(
        "missing knowledge file",
      );
    },
  );

  test.each(["product-graph", "personas", "ux-graph", "business-graph"])(
    "rejects unsupported %s versions",
    async (name) => {
      const files = bookshopFiles();
      const path = `docs/product-context/${name}.json`;
      files[path] = JSON.stringify({ ...JSON.parse(files[path]!), schemaVersion: 99 });
      await expect(loadProductGraph(await fixtureProject(files))).rejects.toThrow();
    },
  );

  test("an architecture reference does not replace the local product or code graph", async () => {
    const files = bookshopFiles();
    files["matrix.config.ts"] =
      'export default { knowledge: { architectureGraph: { path: "docs/architecture/graph.json" } } };';
    files[".matrix/graph/product.json"] = JSON.stringify({
      version: 1,
      nodes: [{ id: "local-feature", label: "Local feature", kind: "feature" }],
      edges: [],
    });
    files[".matrix/graph/code.json"] = "unchanged code graph";
    const root = await fixtureProject(files);
    const graph = await loadProductGraph(root);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.id).toBe("local-feature");
    expect(graph.architecture?.readOnly).toBe(true);
    expect(await readFile(join(root, ".matrix/graph/code.json"), "utf8")).toBe(
      "unchanged code graph",
    );
  });

  test("rejects unsupported versions, malformed data, duplicate ids and unresolved edges", async () => {
    for (const change of [
      { schemaVersion: 2 },
      { nodes: [{ id: "broken" }] },
      {
        nodes: [
          { id: "same", label: "A", kind: "feature" },
          { id: "same", label: "B", kind: "feature" },
        ],
      },
      { edges: [{ from: "catalog", to: "missing", label: "uses" }] },
    ]) {
      const files = bookshopFiles();
      const path = "docs/product-context/product-graph.json";
      files[path] = JSON.stringify({ ...JSON.parse(files[path]!), ...change });
      await expect(loadProductGraph(await fixtureProject(files))).rejects.toThrow();
    }
  });

  test("bounds bytes, collection lengths and unknown field nesting", async () => {
    for (const extra of [
      "a".repeat(4 * 1024 * 1024),
      Array(10001).fill(1),
      Array.from({ length: 34 }).reduce((value) => ({ value }), {}),
    ]) {
      const files = bookshopFiles();
      const path = "docs/product-context/personas.json";
      files[path] = JSON.stringify({ ...JSON.parse(files[path]!), extra });
      await expect(loadProductGraph(await fixtureProject(files))).rejects.toThrow();
    }
  });

  test("rejects traversal and directory/file symlinks for both external sources", async () => {
    const outside = await fixtureProject({ "graph.json": "{}" });
    for (const path of [
      "docs/product-context/product-graph.json",
      "docs/architecture/graph.json",
      "docs/product-context",
    ]) {
      const files = bookshopFiles();
      for (const file of Object.keys(files))
        if (file === path || file.startsWith(`${path}/`)) delete files[file];
      const root = await fixtureProject(files);
      await mkdir(dirname(join(root, path)), { recursive: true });
      await symlink(
        path.endsWith(".json") ? join(outside, "graph.json") : outside,
        join(root, path),
      );
      await expect(loadProductGraph(root)).rejects.toThrow("symlink");
    }
    const root = await fixtureProject({
      "matrix.config.ts":
        'export default {knowledge: {productContext: {path: "../outside", format: "product-context-v1"}}}',
    });
    await expect(loadProductGraph(root)).rejects.toThrow("repository-relative");
  });

  test("reads generated and defineConfig literals without executing code", async () => {
    const root = await fixtureProject({
      "matrix.config.ts":
        'throw new Error("must not execute"); const settings = {architectureGraph: {path: "docs/architecture/graph.json"}}; const config = {knowledge: settings} as const; export default config;',
    });
    expect(await readKnowledgeConfig(root)).toEqual({
      architectureGraph: { path: "docs/architecture/graph.json" },
    });
    await writeFile(
      join(root, "matrix.config.ts"),
      'export default defineConfig({knowledge: {productContext: {path: "docs/product-context", format: "product-context-v1"}}})',
    );
    expect((await readKnowledgeConfig(root)).productContext?.format).toBe("product-context-v1");
    await writeFile(
      join(root, "matrix.config.ts"),
      'export default {knowledge: fetch("somewhere")}',
    );
    await expect(readKnowledgeConfig(root)).rejects.toThrow("static literal");
  });
});
