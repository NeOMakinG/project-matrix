import { isSource } from "@matrix/graph";
import { parseAdr } from "./adr";
import { createSourceIndex } from "./checks";
import { type CheckResult, checkAdrs } from "./engine";
import type { AdrRule } from "./schema";

export interface RuleCase {
  /** Rules to test, as they would appear in a `matrix-rules` block. */
  rules: Partial<AdrRule>[];
  /** In-memory project: repo-relative path → file content. */
  files: Record<string, string>;
  /** ADR number used in reports. Default `0099`. */
  adr?: string;
}

/** Wraps rules into an ADR markdown file, exactly as `matrix init` writes them. */
export function adrMarkdown(number: string, title: string, rules: Partial<AdrRule>[]): string {
  return `# ${Number(number)}. ${title}\n\n- Status: accepted\n\n## Rules\n\n\`\`\`matrix-rules\n${JSON.stringify(rules, null, 2)}\n\`\`\`\n`;
}

/**
 * Test harness for rule authors: runs rules against in-memory files without touching disk.
 * Each hit is reported as `ADR-xxxx file:line`.
 */
export async function runRuleCase(c: RuleCase): Promise<CheckResult & { hits: string[] }> {
  const number = c.adr ?? "0099";
  const adr = parseAdr(`docs/adr/${number}-case.md`, adrMarkdown(number, "Case", c.rules));
  if (!adr) throw new Error("harness produced an unparsable ADR");
  const files = Object.keys(c.files).filter(isSource).sort();
  const result = await checkAdrs(
    [adr],
    createSourceIndex(files, async (f) => c.files[f] ?? ""),
  );
  return { ...result, hits: result.violations.map((v) => `${v.adr} ${v.file}:${v.line}`) };
}
