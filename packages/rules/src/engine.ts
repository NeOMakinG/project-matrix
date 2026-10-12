import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AdrScope, listSourceFiles } from "@matrix/graph";
import { type Adr, DEFAULT_ADR_DIR, isActive, loadAdrs } from "./adr";
import { createSourceIndex, runCheck, type SourceIndex } from "./checks";
import type { RuleSeverity } from "./schema";

export interface Violation {
  adr: string;
  adrTitle: string;
  adrFile: string;
  description: string;
  severity: RuleSeverity;
  file: string;
  line: number;
  message: string;
}

export interface UnenforcedRule {
  adr: string;
  description: string;
  reason: string;
}

export interface InvalidRule {
  adr: string;
  adrFile: string;
  line: number;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  violations: Violation[];
  unenforced: UnenforcedRule[];
  invalid: InvalidRule[];
  stats: { adrs: number; rules: number; enforced: number; files: number };
}

export interface CheckOptions {
  adrDir?: string;
}

/** Runs every active ADR's machine-checkable rules against a set of indexed sources. */
export async function checkAdrs(adrs: Adr[], index: SourceIndex): Promise<CheckResult> {
  const violations: Violation[] = [];
  const unenforced: UnenforcedRule[] = [];
  const invalid: InvalidRule[] = [];
  let rules = 0;
  let enforced = 0;

  for (const adr of adrs) {
    for (const issue of adr.issues)
      invalid.push({ adr: adr.ref, adrFile: adr.file, line: issue.line, message: issue.message });
    if (!isActive(adr)) continue;
    for (const { rule, line } of adr.rules) {
      rules++;
      if (!rule.check) {
        unenforced.push({
          adr: adr.ref,
          description: rule.description,
          reason: "no check body; add a `check` to enforce it",
        });
        continue;
      }
      let hits: Awaited<ReturnType<typeof runCheck>>;
      try {
        hits = await runCheck(rule.check, index);
      } catch (e) {
        invalid.push({ adr: adr.ref, adrFile: adr.file, line, message: (e as Error).message });
        continue;
      }
      enforced++;
      for (const hit of hits)
        violations.push({
          adr: adr.ref,
          adrTitle: adr.title,
          adrFile: adr.file,
          description: rule.description,
          severity: rule.severity,
          ...hit,
        });
    }
  }

  violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.adr.localeCompare(b.adr),
  );
  return {
    ok: invalid.length === 0 && !violations.some((v) => v.severity === "error"),
    violations,
    unenforced,
    invalid,
    stats: { adrs: adrs.length, rules, enforced, files: index.files.length },
  };
}

/** `matrix check`: loads the project's ADRs and enforces their rules on its sources. */
export async function checkProject(root: string, opts: CheckOptions = {}): Promise<CheckResult> {
  const adrs = await loadAdrs(root, opts.adrDir ?? DEFAULT_ADR_DIR);
  const files = await listSourceFiles(root);
  return checkAdrs(
    adrs,
    createSourceIndex(files, (f) => readFile(join(root, f), "utf8")),
  );
}

/** Rule scopes per ADR, for graph queries such as "which ADRs govern this path". */
export function adrScopes(adrs: Adr[]): AdrScope[] {
  const out: AdrScope[] = [];
  for (const adr of adrs) {
    if (!isActive(adr)) continue;
    for (const { rule } of adr.rules) {
      if (!rule.check) continue;
      out.push({
        adr: adr.nodeId,
        title: adr.title,
        ...(rule.check.files ? { files: rule.check.files } : {}),
        ...(rule.check.except ? { except: rule.check.except } : {}),
      });
    }
  }
  return out;
}
