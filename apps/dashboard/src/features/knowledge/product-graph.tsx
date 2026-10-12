import {
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import type { GraphEdge, GraphNode } from "@/api/schemas";
import { Skeleton } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import {
  KIND_ORDER,
  layoutGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
  type PositionedNode,
} from "./graph-layout";

type FactoryNode = Node<
  { label: string; kind: GraphNode["kind"]; highlighted: boolean },
  "factory"
>;

const MONO_KINDS = new Set<GraphNode["kind"]>(["adr", "ticket", "module"]);

function FactoryNodeView({ data }: NodeProps<FactoryNode>) {
  return (
    <div
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={cn(
        "flex items-center gap-2 rounded-control border px-3",
        data.highlighted ? "border-accent bg-accent-dim" : "border-border-strong bg-raised",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-1 !min-w-0 !border-0 !bg-transparent"
      />
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          data.highlighted ? "bg-accent" : "bg-fg-muted",
        )}
      />
      <span
        className={cn(
          "truncate",
          MONO_KINDS.has(data.kind) ? "font-mono text-caption" : "text-label",
          data.highlighted ? "text-fg" : "text-fg-secondary",
        )}
      >
        {data.label}
      </span>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-1 !min-w-0 !border-0 !bg-transparent"
      />
    </div>
  );
}

const nodeTypes = { factory: FactoryNodeView };

export function ProductGraph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const [positioned, setPositioned] = useState<PositionedNode[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    layoutGraph(nodes, edges)
      .then((result) => !cancelled && setPositioned(result))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [nodes, edges]);

  const flowNodes = useMemo<FactoryNode[]>(
    () =>
      (positioned ?? []).map((n) => ({
        id: n.id,
        type: "factory",
        position: { x: n.x, y: n.y },
        data: { label: n.label, kind: n.kind, highlighted: n.highlighted },
        draggable: false,
      })),
    [positioned],
  );

  const highlightedIds = useMemo(
    () => new Set(nodes.filter((n) => n.highlighted).map((n) => n.id)),
    [nodes],
  );
  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => {
        const hot = highlightedIds.has(e.source) && highlightedIds.has(e.target);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "smoothstep",
          style: {
            stroke: hot ? "var(--color-accent)" : "var(--color-border-strong)",
            strokeWidth: hot ? 1.5 : 1,
          },
        };
      }),
    [edges, highlightedIds],
  );

  if (failed) return <p className="px-4 pb-4 text-body text-danger">Couldn't lay out the graph.</p>;

  return (
    <div className="px-4 pb-4">
      <div className="mb-2 grid grid-cols-5 font-mono text-caption tracking-wide text-fg-muted uppercase">
        {KIND_ORDER.map((kind) => (
          <span key={kind}>{kind === "adr" ? "ADRs" : `${kind}s`}</span>
        ))}
      </div>
      {positioned ? (
        <div className="h-[230px]" aria-label="Product graph">
          <ReactFlowProvider>
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.04 }}
              nodesConnectable={false}
              zoomOnScroll={false}
              panOnDrag
              proOptions={{ hideAttribution: true }}
            />
          </ReactFlowProvider>
        </div>
      ) : (
        <Skeleton className="h-[230px]" />
      )}
    </div>
  );
}
