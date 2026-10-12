import type { Receipt } from "@matrix/core";
import { checkGraphDrift } from "@matrix/graph";
import { type CheckOptions, checkProject } from "./engine";
import { toReceipt } from "./report";

/**
 * Architecture gates for the loop's `checks` phase. Both receipts use kind `adr-check`:
 * ADR rules hold, and the committed code graph matches the sources.
 */
export async function architectureGates(root: string, opts: CheckOptions = {}): Promise<Receipt[]> {
  const rules = toReceipt(await checkProject(root, opts));
  const drift = await checkGraphDrift(root);
  return [
    rules,
    {
      kind: "adr-check",
      ok: drift.ok,
      summary: drift.ok
        ? "code graph is up to date"
        : `code graph is stale: ${drift.stale.join(", ")} (run \`matrix graph\`)`,
      data: drift,
    },
  ];
}
