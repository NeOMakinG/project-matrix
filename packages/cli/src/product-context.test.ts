import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProductGraph } from "@matrix/graph";
import { sampleAnswers } from "@matrix/packs";
import { describe, expect, test, vi } from "vitest";
import { bookshopFiles } from "../../graph/src/product-context.fixture";
import { fixtureProject } from "../../graph/src/test-utils";
import { checkCommand } from "./check";
import { graphCommand } from "./graph";
import { runInit } from "./init";

describe("existing external knowledge onboarding", () => {
  test("adds discovered knowledge settings without replacing existing configuration", async () => {
    const files = bookshopFiles();
    files["matrix.config.ts"] =
      'const config = { customSetting: "keep-me" } as const; export default config;';
    const root = await fixtureProject(files);
    const result = await runInit({
      answers: sampleAnswers,
      existingRepo: root,
      outDir: root,
      acceptRecommended: true,
      scaffold: false,
    });
    expect(result.status).toBe("ok");
    expect(await readFile(join(root, "matrix.config.ts"), "utf8")).toContain(
      'customSetting: "keep-me"',
    );
    expect((await loadProductGraph(root)).nodes.some((node) => node.id === "catalog")).toBe(true);
    await expect(readFile(join(root, ".matrix/graph/product.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  test.each([true, false])(
    "keeps external sources authoritative (existing config: %s)",
    async (withConfig) => {
      const files = bookshopFiles();
      if (!withConfig) delete files["matrix.config.ts"];
      const root = await fixtureProject(files);
      const result = await runInit({
        answers: sampleAnswers,
        existingRepo: root,
        outDir: root,
        acceptRecommended: true,
        scaffold: false,
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.config.knowledge?.productContext).toEqual({
        path: "docs/product-context",
        format: "product-context-v1",
      });
      expect(result.files).not.toContain(".matrix/graph/product.json");
      await expect(readFile(join(root, ".matrix/graph/product.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await loadProductGraph(root)).nodes.some((node) => node.id === "catalog")).toBe(true);
      for (const [path, content] of Object.entries(files))
        expect(await readFile(join(root, path), "utf8")).toBe(content);
      if (!withConfig)
        expect(await readFile(join(root, "matrix.config.ts"), "utf8")).toContain(
          "product-context-v1",
        );
    },
  );

  test("explicit adapter answers survive config generation", async () => {
    const files = bookshopFiles();
    delete files["matrix.config.ts"];
    const root = await fixtureProject(files);
    const result = await runInit({
      answers: {
        ...sampleAnswers,
        "knowledge.productContext.path": "docs/product-context",
        "knowledge.productContext.format": "product-context-v1",
        "knowledge.architectureGraph.path": "docs/architecture/graph.json",
      },
      outDir: root,
      acceptRecommended: true,
      scaffold: false,
    });
    expect(result.status).toBe("ok");
    expect((await loadProductGraph(root)).architecture?.readOnly).toBe(true);
    await expect(readFile(join(root, ".matrix/graph/product.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("graph queries use declared files and check commands fail closed", async () => {
    const root = await fixtureProject(bookshopFiles());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await graphCommand(["query", "impact", "src/catalog.ts", "--dir", root, "--json"]),
      ).toBe(0);
      expect(JSON.parse(log.mock.calls.at(-1)![0]).features).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "catalog" })]),
      );
      expect(await graphCommand([root])).toBe(0);
      expect(await graphCommand([root, "--check"])).toBe(0);
      await writeFile(join(root, "docs/product-context/personas.json"), "{}");
      expect(await graphCommand([root, "--check"])).toBe(1);
      expect(await checkCommand([root, "--json"])).toBe(1);
      expect(JSON.parse(log.mock.calls.at(-1)![0]).failures.join(" ")).toContain(
        "invalid product knowledge",
      );
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
