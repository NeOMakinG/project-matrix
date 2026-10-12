import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildCodeGraph, type CodeGraph } from "./code";
import { renderGraphMarkdown } from "./render";

export const CODE_GRAPH_PATH = ".matrix/graph/code.json";
export const GRAPH_MD_PATH = ".matrix/graph/GRAPH.md";

export interface GraphArtifacts {
  graph: CodeGraph;
  files: Record<string, string>;
}

/** Builds the code graph and its committed artifacts (JSON + markdown summary). */
export async function graphArtifacts(root: string): Promise<GraphArtifacts> {
  const graph = await buildCodeGraph(root);
  return {
    graph,
    files: {
      [CODE_GRAPH_PATH]: `${JSON.stringify(graph, null, 2)}\n`,
      [GRAPH_MD_PATH]: renderGraphMarkdown(graph),
    },
  };
}

export async function writeGraph(root: string): Promise<GraphArtifacts> {
  const artifacts = await graphArtifacts(root);
  for (const [rel, content] of Object.entries(artifacts.files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  return artifacts;
}

export interface DriftResult {
  ok: boolean;
  /** Artifacts that are missing or differ from a fresh build. */
  stale: string[];
}

/** Compares committed graph artifacts with a fresh build. */
export async function checkGraphDrift(root: string): Promise<DriftResult> {
  const { files } = await graphArtifacts(root);
  const stale: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const current = await readFile(join(root, rel), "utf8").catch(() => undefined);
    if (current !== content) stale.push(rel);
  }
  return { ok: stale.length === 0, stale };
}

export async function readCodeGraph(root: string): Promise<CodeGraph | undefined> {
  const raw = await readFile(join(root, CODE_GRAPH_PATH), "utf8").catch(() => undefined);
  return raw ? (JSON.parse(raw) as CodeGraph) : undefined;
}
