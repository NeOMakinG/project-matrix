import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readArchitectureReference, readKnowledgeConfig } from "./knowledge";
import { readProductContext } from "./product-context";

export const PRODUCT_GRAPH_PATH = ".matrix/graph/product.json";

/**
 * Node kinds. `decision` nodes are ADRs (`adr:NNNN`), `ux` nodes are UX/product decisions,
 * `module` nodes are code paths (`module:apps/web/src/billing`).
 */
export const NODE_KINDS = [
  "goal",
  "metric",
  "persona",
  "feature",
  "ux",
  "decision",
  "ticket",
  "module",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Edge kinds and their direction. */
export const EDGE_KINDS = {
  "measured-by": "goal → metric",
  has: "persona → goal",
  solves: "feature → goal",
  "decided-for": "ux → feature",
  governs: "decision → feature | module | ux",
  implements: "ticket → feature | ux",
  touches: "ticket → module",
  realizes: "module → feature",
  "depends-on": "any → any",
} as const;
export type EdgeKind = keyof typeof EDGE_KINDS;

export const productNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(NODE_KINDS),
  label: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const productEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.string().min(1),
});

export const productGraphSchema = z
  .object({
    version: z.literal(1),
    nodes: z.array(productNodeSchema),
    edges: z.array(productEdgeSchema),
    context: z.record(z.string(), z.unknown()).optional(),
    architecture: z
      .object({ path: z.string(), readOnly: z.literal(true), graph: z.unknown() })
      .optional(),
  })
  .superRefine((g, ctx) => {
    const ids = new Set<string>();
    for (const [i, n] of g.nodes.entries()) {
      if (ids.has(n.id))
        ctx.addIssue({ code: "custom", path: ["nodes", i, "id"], message: `duplicate ${n.id}` });
      ids.add(n.id);
    }
    for (const [i, e] of g.edges.entries()) {
      for (const end of ["from", "to"] as const) {
        if (!ids.has(e[end]))
          ctx.addIssue({
            code: "custom",
            path: ["edges", i, end],
            message: `unknown node ${e[end]}`,
          });
      }
    }
  });

export type ProductNode = z.infer<typeof productNodeSchema>;
export type ProductEdge = z.infer<typeof productEdgeSchema>;
export type ProductGraph = z.infer<typeof productGraphSchema>;

export const emptyProductGraph = (): ProductGraph => ({ version: 1, nodes: [], edges: [] });

export const moduleId = (path: string) => `module:${path.replace(/\/+$/, "")}`;
export const ticketId = (id: string) => `ticket:${id}`;

export function parseProductGraph(raw: unknown): ProductGraph {
  return productGraphSchema.parse(raw);
}

export async function loadProductGraph(root: string): Promise<ProductGraph> {
  const knowledge = await readKnowledgeConfig(root);
  const graph = knowledge.productContext
    ? await readProductContext(root, knowledge.productContext)
    : await loadLocalProductGraph(root);
  const architecture = await readArchitectureReference(root, knowledge);
  return architecture ? { ...graph, architecture } : graph;
}

async function loadLocalProductGraph(root: string): Promise<ProductGraph> {
  const raw = await readFile(join(root, PRODUCT_GRAPH_PATH), "utf8").catch(() => undefined);
  return raw ? parseProductGraph(JSON.parse(raw)) : emptyProductGraph();
}

/** Stable serialisation: nodes keep insertion order, duplicate edges are dropped. */
export function serializeProductGraph(g: ProductGraph): string {
  return `${JSON.stringify(parseProductGraph(g), null, 2)}\n`;
}

export async function saveProductGraph(root: string, g: ProductGraph): Promise<void> {
  if ((await readKnowledgeConfig(root)).productContext)
    throw new Error("external product context is read-only");
  const path = join(root, PRODUCT_GRAPH_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeProductGraph(g));
}

/** Adds the node, or updates its label/data when it already exists. */
export function upsertNode(g: ProductGraph, node: ProductNode): ProductGraph {
  const i = g.nodes.findIndex((n) => n.id === node.id);
  if (i === -1) g.nodes.push(node);
  else g.nodes[i] = { ...g.nodes[i], ...node };
  return g;
}

/** Adds an edge once; both ends must exist. */
export function link(g: ProductGraph, from: string, to: string, kind: EdgeKind): ProductGraph {
  for (const id of [from, to]) {
    if (!g.nodes.some((n) => n.id === id)) throw new Error(`product graph has no node ${id}`);
  }
  if (!g.edges.some((e) => e.from === from && e.to === to && e.kind === kind))
    g.edges.push({ from, to, kind });
  return g;
}

/** Records a ticket and the features or UX decisions it implements. */
export function linkTicket(
  g: ProductGraph,
  ticket: { id: string; title: string },
  implementsIds: string[],
): ProductGraph {
  upsertNode(g, { id: ticketId(ticket.id), kind: "ticket", label: ticket.title });
  for (const target of implementsIds) link(g, ticketId(ticket.id), target, "implements");
  return g;
}

/** Records a code module (file or folder) and the features it realizes. */
export function linkModule(g: ProductGraph, path: string, featureIds: string[]): ProductGraph {
  upsertNode(g, { id: moduleId(path), kind: "module", label: path });
  for (const f of featureIds) link(g, moduleId(path), f, "realizes");
  return g;
}
