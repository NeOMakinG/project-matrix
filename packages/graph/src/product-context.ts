import { posix } from "node:path";
import { knowledgePath } from "@matrix/config";
import { z } from "zod";
import { type KnowledgeConfig, readKnowledgeJson } from "./knowledge";
import {
  moduleId,
  NODE_KINDS,
  type ProductGraph,
  type ProductNode,
  parseProductGraph,
} from "./product";

const text = z.string().max(65536);
const id = z.string().min(1).max(1024);
const strings = z.array(text).max(10000);
const list = <Schema extends z.ZodType>(schema: Schema) => z.array(schema).max(10000);
const node = z
  .object({
    id,
    label: text,
    kind: id,
    code: strings.optional(),
    api: strings.optional(),
    references: strings.optional(),
  })
  .passthrough();
const edge = z.object({ from: id, to: id, label: id }).passthrough();
const journey = z
  .object({ id, persona: text, start: text, end: text, proof: strings })
  .passthrough();
const base = z.object({ schemaVersion: z.literal(1), scope: text.optional() }).passthrough();
export const productContextSchemas = {
  "product-graph": base.extend({
    nodes: list(node),
    edges: list(edge),
    entityLifecycles: list(z.object({ id, states: strings, actions: strings }).passthrough()),
    journeys: list(journey),
    dataBoundaries: strings,
  }),
  personas: base.extend({
    personas: list(
      z
        .object({
          id,
          name: text,
          basis: text,
          job: text,
          success: text,
          contexts: strings.optional(),
          expectations: strings,
          journeys: strings,
        })
        .passthrough(),
    ),
  }),
  "ux-graph": base.extend({
    features: list(
      z
        .object({
          id,
          label: text,
          codeRoots: strings,
          runtimeInputs: strings,
          bindings: strings,
          entities: strings.optional(),
        })
        .passthrough(),
    ),
    states: list(z.object({ id, feature: id, label: text }).passthrough()),
    transitions: list(z.object({ from: id, to: id, event: text }).passthrough()),
    bindings: list(
      z
        .object({
          id,
          feature: id,
          journey: text,
          personas: strings,
          productNodes: strings,
          businessNodes: strings,
          code: strings,
          tests: strings,
          actions: strings,
          cases: list(z.object({ id, description: text, scopes: strings }).passthrough()),
        })
        .passthrough(),
    ),
  }),
  "business-graph": base.extend({
    nodes: list(node),
    edges: list(edge),
    candidateMetrics: list(
      z
        .object({ id, definition: text, decisionState: text, instrumentation: text.optional() })
        .passthrough(),
    ),
    businessConstraints: strings,
    openDecisions: strings,
    evidence: strings,
  }),
};

export async function readProductContext(
  root: string,
  config: NonNullable<KnowledgeConfig["productContext"]>,
): Promise<ProductGraph> {
  const read = async <Schema extends z.ZodType>(name: string, schema: Schema) =>
    schema.parse(await readKnowledgeJson(root, posix.join(config.path, `${name}.json`)));
  const product = await read("product-graph", productContextSchemas["product-graph"]);
  const personas = await read("personas", productContextSchemas.personas);
  const ux = await read("ux-graph", productContextSchemas["ux-graph"]);
  const business = await read("business-graph", productContextSchemas["business-graph"]);
  const graph: ProductGraph = {
    version: 1,
    nodes: [],
    edges: [],
    context: { product, personas, ux, business },
  };
  const ids = new Set<string>();
  const kinds = new Map<string, ProductNode["kind"]>();
  const edges = new Set<string>();
  function add(node: ProductNode): void {
    if (ids.has(node.id)) throw new Error(`duplicate product context node: ${node.id}`);
    if (graph.nodes.length >= 100000) throw new Error("mapped product graph has too many nodes");
    ids.add(node.id);
    kinds.set(node.id, node.kind);
    graph.nodes.push(node);
  }
  function connect(from: string, to: string, kind: string): void {
    if (!ids.has(from) || !ids.has(to))
      throw new Error(`unresolved product context edge: ${from} -> ${to}`);
    const key = JSON.stringify([from, to, kind]);
    if (!edges.has(key)) {
      if (graph.edges.length >= 200000) throw new Error("mapped product graph has too many edges");
      edges.add(key);
      graph.edges.push({ from, to, kind });
    }
  }
  function files(target: string, paths: string[]): void {
    for (const raw of paths) {
      const path = knowledgePath
        .parse(raw)
        .replaceAll("\\", "/")
        .replace(/^\.\//, "")
        .replace(/\/+$/, "");
      const module = moduleId(path);
      if (!ids.has(module)) add({ id: module, kind: "module", label: path });
      else if (kinds.get(module) !== "module") throw new Error(`module id collision: ${module}`);
      connect(module, target, "realizes");
    }
  }
  function mapKind(kind: string): ProductNode["kind"] {
    return NODE_KINDS.includes(kind as ProductNode["kind"])
      ? (kind as ProductNode["kind"])
      : "feature";
  }
  for (const source of product.nodes)
    add({ id: source.id, kind: mapKind(source.kind), label: source.label, data: source });
  for (const source of personas.personas)
    add({ id: `persona:${source.id}`, kind: "persona", label: source.name, data: source });
  for (const source of business.nodes)
    add({
      id: `business:${source.id}`,
      kind: mapKind(source.kind),
      label: source.label,
      data: source,
    });
  for (const source of business.candidateMetrics)
    add({ id: `metric:${source.id}`, kind: "metric", label: source.definition, data: source });
  for (const source of product.entityLifecycles) {
    add({ id: `lifecycle:${source.id}`, kind: "feature", label: source.id, data: source });
    if (ids.has(source.id)) connect(`lifecycle:${source.id}`, source.id, "depends-on");
  }
  for (const source of product.journeys)
    add({
      id: `journey:${source.id}`,
      kind: "ux",
      label: `${source.start} → ${source.end}`,
      data: source,
    });
  for (const source of ux.features)
    add({ id: `ux:feature:${source.id}`, kind: "feature", label: source.label, data: source });
  for (const source of ux.states)
    add({ id: `ux:state:${source.id}`, kind: "ux", label: source.label, data: source });
  for (const source of ux.bindings)
    add({ id: `ux:binding:${source.id}`, kind: "ux", label: source.id, data: source });
  for (const source of product.edges) connect(source.from, source.to, source.label);
  for (const source of business.edges)
    connect(`business:${source.from}`, `business:${source.to}`, source.label);
  for (const source of product.nodes)
    files(source.id, [
      ...(source.code ?? []),
      ...(source.api ?? []).filter(
        (value) =>
          !/^(?:[\\/]|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(value) && /\.[a-zA-Z\d]+$/.test(value),
      ),
      ...(source.references ?? []),
    ]);
  for (const source of business.nodes)
    files(`business:${source.id}`, [...(source.code ?? []), ...(source.references ?? [])]);
  for (const source of product.journeys) {
    files(`journey:${source.id}`, source.proof);
    if (ids.has(`persona:${source.persona}`))
      connect(`persona:${source.persona}`, `journey:${source.id}`, "has");
  }
  for (const source of personas.personas)
    for (const journey of source.journeys)
      if (ids.has(`journey:${journey}`))
        connect(`persona:${source.id}`, `journey:${journey}`, "has");
  for (const source of ux.features) files(`ux:feature:${source.id}`, source.codeRoots);
  for (const source of ux.states)
    connect(`ux:state:${source.id}`, `ux:feature:${source.feature}`, "decided-for");
  for (const source of ux.transitions)
    connect(`ux:state:${source.from}`, `ux:state:${source.to}`, source.event);
  for (const source of ux.bindings) {
    const binding = `ux:binding:${source.id}`;
    connect(binding, `ux:feature:${source.feature}`, "decided-for");
    for (const target of source.productNodes) connect(binding, target, "decided-for");
    for (const target of source.businessNodes) connect(binding, `business:${target}`, "depends-on");
    for (const target of source.personas) connect(`persona:${target}`, binding, "has");
    if (ids.has(`journey:${source.journey}`))
      connect(binding, `journey:${source.journey}`, "depends-on");
    files(binding, [...source.code, ...source.tests]);
    for (const target of source.productNodes) files(target, [...source.code, ...source.tests]);
  }
  return parseProductGraph(graph);
}
