import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AdrScope,
  createResolver,
  loadProductGraph,
  readKnowledgeConfig,
  type SymlinkEscape,
  scanSources,
} from "@matrix/graph";
import picomatch from "picomatch";
import { type Adr, DEFAULT_ADR_DIR, isActive } from "./adr";
import { createSourceIndex, runCheck, type SourceIndex } from "./checks";
import type { RuleSeverity } from "./schema";
import {
  type AdrChange,
  countEnforced,
  diffAdrs,
  loadRulesAt,
  loadWorktreeRules,
  type RulesSource,
} from "./source";

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
  /** Fail-closed reasons: missing rules, rule-count drops, symlinks escaping the repo. */
  failures: string[];
  escapes: SymlinkEscape[];
  rulesSource: RulesSource;
  /** ADR files changed relative to the rules source; they need human review. */
  adrChanges: AdrChange[];
  requiresReview: boolean;
}

export interface CheckOptions {
  adrDir?: string;
  /** Load rules from this git ref's merge-base with HEAD (`base` = main) instead of the tree. */
  rulesFrom?: string;
  /** Accept fewer enforced rules than the base (after a human approved the ADR change). */
  allowRuleRemoval?: boolean;
}

/** Runs every active ADR's machine-checkable rules against a set of indexed sources. */
/** Result of running rules alone, before project-level fail-closed checks. */
export type RuleCheckResult = Omit<
  CheckResult,
  "failures" | "escapes" | "rulesSource" | "adrChanges" | "requiresReview"
>;

export async function checkAdrs(adrs: Adr[], index: SourceIndex): Promise<RuleCheckResult> {
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

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** A project generated or onboarded by Matrix must have rules; zero rules fails closed. */
const isMatrixProject = async (root: string) =>
  (await exists(join(root, "matrix.config.ts"))) ||
  (await exists(join(root, ".matrix/answers.json")));

/**
 * `matrix check`. Rules come from the working tree, or with `rulesFrom` from the base commit so
 * the code under check cannot weaken them. Fails closed when rules are missing or shrink.
 */
export async function checkProject(root: string, opts: CheckOptions = {}): Promise<CheckResult> {
  const adrDir = opts.adrDir ?? DEFAULT_ADR_DIR;
  const worktree = await loadWorktreeRules(root, adrDir);
  const rules = opts.rulesFrom ? loadRulesAt(root, opts.rulesFrom, adrDir) : worktree;
  const allowSubmodule = picomatch(rules.manifest?.allowSubmodules ?? [], { dot: true });
  const listing = await scanSources(root, { includeSubmodule: (p) => allowSubmodule(p) });
  const resolver = await createResolver(root, listing.files);
  const index = createSourceIndex(listing.files, (f) => readFile(join(root, f), "utf8"), {
    textFiles: listing.textFiles,
    allFiles: listing.allFiles,
    diskRoot: root,
    root,
    resolver,
  });
  const result = await checkAdrs(rules.adrs, index);

  const failures: string[] = [];
  try {
    const knowledge = await readKnowledgeConfig(root);
    if (knowledge.productContext || knowledge.architectureGraph) await loadProductGraph(root);
  } catch (error) {
    failures.push(`invalid product knowledge: ${(error as Error).message}`);
  }
  for (const e of listing.escapes)
    failures.push(`symlink ${e.path} points outside the repository (${e.target})`);
  for (const sub of listing.submodules) {
    if (!allowSubmodule(sub.path))
      failures.push(
        `submodule ${sub.path} hides code from matrix check; allow it in .matrix/rules-manifest.json (allowSubmodules) to check its files`,
      );
    else if (!sub.populated)
      failures.push(
        `submodule ${sub.path} is allowed but not checked out (git submodule update --init); its code cannot be checked`,
      );
  }
  const enforced = result.stats.enforced;
  const where = rules.source.kind === "git" ? `base ${rules.source.commit.slice(0, 12)}` : adrDir;
  if (rules.manifest && enforced < rules.manifest.minRules)
    failures.push(
      `only ${enforced} enforced ADR rules loaded from ${where}; the rules manifest requires ${rules.manifest.minRules}`,
    );
  else if (!rules.manifest && enforced === 0 && (await isMatrixProject(root)))
    failures.push(`no enforced ADR rules loaded from ${where}; a Matrix project must declare them`);

  const adrChanges = rules.source.kind === "git" ? diffAdrs(rules.files, worktree.files) : [];
  if (rules.source.kind === "git" && !opts.allowRuleRemoval) {
    const head = countEnforced(worktree.adrs);
    if (head < enforced)
      failures.push(
        `this change drops enforced ADR rules from ${enforced} to ${head}; needs human approval (--allow-rule-removal)`,
      );
  }

  return {
    ...result,
    ok: result.ok && failures.length === 0,
    failures,
    escapes: listing.escapes,
    rulesSource: rules.source,
    adrChanges,
    requiresReview: adrChanges.length > 0,
  };
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
