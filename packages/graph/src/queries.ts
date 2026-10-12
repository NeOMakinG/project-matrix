import type { CodeGraph } from "./code";
import { inScope, type Scope } from "./files";
import { type ProductGraph, type ProductNode, ticketId } from "./product";

export interface Importer {
  path: string;
  line: number;
}

/** Modules that import `path` directly. */
export function importersOf(code: CodeGraph, path: string): Importer[] {
  const out: Importer[] = [];
  for (const m of code.modules)
    for (const i of m.imports) if (i.target === path) out.push({ path: m.path, line: i.line });
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/** Modules importing a package (bare specifier, e.g. `drizzle-orm`). */
export function importersOfPackage(code: CodeGraph, pkg: string): Importer[] {
  const out: Importer[] = [];
  for (const m of code.modules)
    for (const i of m.imports) if (i.package === pkg) out.push({ path: m.path, line: i.line });
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/** Repo files `path` imports directly. */
export function dependenciesOf(code: CodeGraph, path: string): string[] {
  const m = code.modules.find((x) => x.path === path);
  return [...new Set(m?.imports.flatMap((i) => (i.target ? [i.target] : [])) ?? [])].sort();
}

/** `path` plus every module that depends on it, directly or transitively. */
export function dependents(code: CodeGraph, path: string): string[] {
  const reverse = new Map<string, string[]>();
  for (const m of code.modules)
    for (const i of m.imports)
      if (i.target) reverse.set(i.target, [...(reverse.get(i.target) ?? []), m.path]);
  const seen = new Set([path]);
  const queue = [path];
  for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
    for (const r of reverse.get(p) ?? []) {
      if (!seen.has(r)) {
        seen.add(r);
        queue.push(r);
      }
    }
  }
  return [...seen].sort();
}

/** ADR scopes, as produced by `@matrix/rules` from the `matrix-rules` blocks. */
export interface AdrScope extends Scope {
  adr: string;
  title?: string;
}

const coversPath = (modulePath: string, path: string) =>
  path === modulePath || path.startsWith(`${modulePath}/`);

const nodesById = (g: ProductGraph) => new Map(g.nodes.map((n) => [n.id, n]));

/** ADR ids that govern a path: through rule scopes, or `governs` edges to a module node. */
export function adrsGoverning(path: string, scopes: AdrScope[], product?: ProductGraph): string[] {
  const out = new Set<string>();
  for (const s of scopes) if (inScope(path, s)) out.add(s.adr);
  if (product) {
    const nodes = nodesById(product);
    for (const e of product.edges) {
      if (e.kind !== "governs") continue;
      const target = nodes.get(e.to);
      if (target?.kind === "module" && coversPath(target.label, path)) out.add(e.from);
    }
  }
  return [...out].sort();
}

/** Feature nodes a ticket touches: implemented directly, or through modules it touches. */
export function featuresForTicket(product: ProductGraph, id: string): ProductNode[] {
  const nodes = nodesById(product);
  const tid = id.startsWith("ticket:") ? id : ticketId(id);
  const features = new Set<string>();
  const modules = new Set<string>();
  for (const e of product.edges) {
    if (e.from !== tid) continue;
    if (e.kind === "implements" && nodes.get(e.to)?.kind === "feature") features.add(e.to);
    if (e.kind === "implements" && nodes.get(e.to)?.kind === "ux")
      for (const u of product.edges)
        if (u.from === e.to && u.kind === "decided-for") features.add(u.to);
    if (e.kind === "touches") modules.add(e.to);
  }
  for (const e of product.edges)
    if (e.kind === "realizes" && modules.has(e.from)) features.add(e.to);
  return [...features].flatMap((f) => (nodes.has(f) ? [nodes.get(f) as ProductNode] : []));
}

/** Features realized by modules covering `path`. */
export function featuresForPath(product: ProductGraph, path: string): ProductNode[] {
  const nodes = nodesById(product);
  const out = new Set<string>();
  for (const e of product.edges) {
    if (e.kind !== "realizes") continue;
    const m = nodes.get(e.from);
    if (m?.kind === "module" && coversPath(m.label, path)) out.add(e.to);
  }
  return [...out].sort().flatMap((f) => (nodes.has(f) ? [nodes.get(f) as ProductNode] : []));
}

export interface Impact {
  /** The changed file and every module depending on it. */
  modules: string[];
  features: ProductNode[];
  adrs: string[];
}

/** What a change to `path` can affect: dependent modules, product features and governing ADRs. */
export function impactOfFile(
  path: string,
  ctx: { code: CodeGraph; product?: ProductGraph; adrScopes?: AdrScope[] },
): Impact {
  const modules = dependents(ctx.code, path);
  const features = new Map<string, ProductNode>();
  const adrs = new Set<string>();
  for (const m of modules) {
    if (ctx.product) for (const f of featuresForPath(ctx.product, m)) features.set(f.id, f);
    for (const a of adrsGoverning(m, ctx.adrScopes ?? [], ctx.product)) adrs.add(a);
  }
  return {
    modules,
    features: [...features.values()].sort((a, b) => a.id.localeCompare(b.id)),
    adrs: [...adrs].sort(),
  };
}
