import type { ELK as ElkInstance } from "elkjs/lib/elk-api";
import type { GraphEdgeView, GraphNodeView } from "@/api/view";

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 34;

export const KIND_ORDER = ["goal", "feature", "adr", "ticket", "module"] as const;

export type PositionedNode = GraphNodeView & { x: number; y: number };

function partition(kind: string): number {
  const index = (KIND_ORDER as readonly string[]).indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

let elkPromise: Promise<ElkInstance> | null = null;

/** ELK runs in a web worker in the browser; jsdom/tests fall back to the bundled build. */
function getElk(): Promise<ElkInstance> {
  elkPromise ??= (async () => {
    if (typeof Worker !== "undefined") {
      const [{ default: ELK }, { default: workerUrl }] = await Promise.all([
        import("elkjs/lib/elk-api"),
        import("elkjs/lib/elk-worker.min.js?url"),
      ]);
      return new ELK({ workerFactory: () => new Worker(workerUrl) });
    }
    if (import.meta.env.MODE !== "test") throw new Error("The graph layout needs Web Workers");
    const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
    return new ELK();
  })();
  return elkPromise;
}

export async function layoutGraph(
  nodes: GraphNodeView[],
  edges: GraphEdgeView[],
): Promise<PositionedNode[]> {
  const elk = await getElk();
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
      layoutOptions: { "elk.partitioning.partition": String(partition(n.kind)) },
    })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  const byId = new Map(result.children?.map((c) => [c.id, c]) ?? []);
  return nodes.map((n) => {
    const placed = byId.get(n.id);
    return { ...n, x: placed?.x ?? 0, y: placed?.y ?? 0 };
  });
}

/** Ids of the selected node, everything it depends on, and everything that depends on it. */
export function pathThrough(selected: string | null, edges: readonly GraphEdgeView[]): Set<string> {
  const out = new Set<string>();
  if (!selected) return out;
  out.add(selected);
  const walk = (start: string, dir: "up" | "down") => {
    const stack = [start];
    while (stack.length) {
      const id = stack.pop() as string;
      for (const e of edges) {
        const next =
          dir === "down" ? (e.source === id ? e.target : null) : e.target === id ? e.source : null;
        if (next && !out.has(next)) {
          out.add(next);
          stack.push(next);
        }
      }
    }
  };
  walk(selected, "up");
  walk(selected, "down");
  return out;
}
