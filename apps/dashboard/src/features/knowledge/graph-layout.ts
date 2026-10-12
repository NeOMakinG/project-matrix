import ELK from "elkjs/lib/elk.bundled.js";
import type { GraphEdge, GraphNode } from "@/api/schemas";

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 34;

export const KIND_ORDER: GraphNode["kind"][] = ["goal", "feature", "adr", "ticket", "module"];

export type PositionedNode = GraphNode & { x: number; y: number };

const elk = new ELK();

export async function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Promise<PositionedNode[]> {
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.partitioning.activate": "true",
      "elk.layered.spacing.nodeNodeBetweenLayers": "42",
      "elk.spacing.nodeNode": "52",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      layoutOptions: { "elk.partitioning.partition": String(KIND_ORDER.indexOf(n.kind)) },
    })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  const byId = new Map(result.children?.map((c) => [c.id, c]) ?? []);
  return nodes.map((n) => {
    const placed = byId.get(n.id);
    return { ...n, x: placed?.x ?? 0, y: placed?.y ?? 0 };
  });
}
