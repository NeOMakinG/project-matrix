import { loadProductGraph } from "@matrix/graph";
import { architectureGates, loadAdrs } from "@matrix/rules";
import type { Adr, CheckResult, ProductGraph } from "../core-port.js";
import type { KnowledgePort } from "./real-core.js";

interface RuleViolation {
  adr: string;
  description: string;
  severity: string;
  file: string;
  line: number;
  message: string;
}

/** ADRs, product graph and `matrix check` read from the project repo with @matrix/rules + @matrix/graph. */
export const repoKnowledge: KnowledgePort = {
  async adrs(repoPath): Promise<Adr[]> {
    const adrs = await loadAdrs(repoPath).catch(() => []);
    return adrs.map((adr) => ({
      id: adr.number,
      title: adr.title,
      status: adr.status ?? "unknown",
      path: adr.file,
      rules: adr.rules.map((r) => r.rule.description),
    }));
  },

  async graph(repoPath): Promise<ProductGraph> {
    const graph = await loadProductGraph(repoPath);
    return {
      nodes: graph.nodes.map((n) => ({ id: n.id, kind: toServerKind(n.kind), label: n.label })),
      edges: graph.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
    };
  },

  async checks(repoPath, baseBranch): Promise<CheckResult> {
    const receipts = await architectureGates(repoPath, baseBranch ? { rulesFrom: baseBranch } : {});
    const rules = receipts.find(
      (r) =>
        r.kind === "adr-check" && Array.isArray((r.data as { violations?: unknown })?.violations),
    );
    const violations = ((rules?.data as { violations?: RuleViolation[] })?.violations ?? []).map(
      (v) => ({
        level: v.severity === "error" ? ("error" as const) : ("warn" as const),
        adr: v.adr,
        location: `${v.file}:${v.line}`,
        message: v.message,
        note: v.description,
      }),
    );
    const drift = receipts.find((r) => r !== rules && r.kind === "adr-check" && !r.ok);
    if (drift) {
      violations.push({
        level: "error",
        adr: "graph",
        location: ".matrix/graph",
        message: drift.summary,
        note: "",
      });
    }
    return { ref: "working tree", violations };
  },
};

const SERVER_KINDS = new Set(["goal", "persona", "feature", "decision", "ticket", "module"]);

/** The server's graph view has fewer node kinds; metric and ux nodes are shown as features/decisions. */
function toServerKind(kind: string): ProductGraph["nodes"][number]["kind"] {
  if (SERVER_KINDS.has(kind)) return kind as ProductGraph["nodes"][number]["kind"];
  if (kind === "ux") return "decision";
  if (kind === "metric") return "goal";
  return "feature";
}
