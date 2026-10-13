import { describe, expect, test } from "vitest";
import { bookshopFiles } from "../../../../packages/graph/src/product-context.fixture";
import { fixtureProject } from "../../../../packages/graph/src/test-utils";
import { ProductGraph } from "../http/schemas";
import { repoKnowledge } from "./knowledge";

describe("external knowledge API", () => {
  test("retains source details and the read-only architecture reference", async () => {
    const root = await fixtureProject(bookshopFiles());
    const graph = ProductGraph.parse(await repoKnowledge.graph(root));
    expect(graph.context).toHaveProperty("product");
    expect(graph.nodes.find((node) => node.id === "lifecycle:basket")?.data).toMatchObject({
      actions: ["add-book"],
    });
    expect(graph.architecture).toMatchObject({
      path: "docs/architecture/graph.json",
      readOnly: true,
      graph: { custom: "Read only" },
    });
  });
});
