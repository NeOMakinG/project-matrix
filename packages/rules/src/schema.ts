import { z } from "zod";

const globs = z.array(z.string().min(1));

const scope = {
  /** Globs (repo-relative) the rule applies to. Default: every source file. */
  files: globs.optional(),
  /** Globs exempt from the rule. */
  except: globs.optional(),
};

/**
 * Machine-checkable rule bodies. `matrix check` runs them natively; the ADR's `engine`
 * field names the external tool whose semantics a rule mirrors.
 */
export const ruleCheckSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("forbidden-import"),
    ...scope,
    /** Regex tested against each module specifier (bare or relative). */
    import: z.string().min(1),
    /** Also flag `import type` (default: type-only imports are allowed). */
    includeTypeImports: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("boundary"),
    ...scope,
    /** Repo files (globs) that files in scope must not import. */
    disallow: globs.min(1),
    /** Exceptions inside `disallow`. */
    allow: globs.optional(),
    includeTypeImports: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("call-pattern"),
    ...scope,
    /** ast-grep style call pattern: `fetch($$$)`, `db.execute($A)`, `console.log($$$)`. */
    pattern: z.string().min(1),
  }),
  z.object({
    type: z.literal("regex"),
    ...scope,
    pattern: z.string().min(1),
    flags: z.string().optional(),
  }),
  z.object({
    type: z.literal("required-header"),
    files: globs.min(1),
    except: globs.optional(),
    /** Regex the first lines of every file in scope must match. */
    header: z.string().min(1),
  }),
]);

export const RULE_ENGINES = [
  "dependency-cruiser",
  "ast-grep",
  "biome",
  "semgrep",
  "custom",
] as const;

export const adrRuleSchema = z.object({
  engine: z.enum(RULE_ENGINES).default("custom"),
  description: z.string().min(1),
  /** Legacy free-form pattern from rule stubs; informative only. */
  pattern: z.string().optional(),
  severity: z.enum(["error", "warning"]).default("error"),
  check: ruleCheckSchema.optional(),
});

export const adrRulesBlockSchema = z.array(adrRuleSchema);

export type RuleCheck = z.infer<typeof ruleCheckSchema>;
export type AdrRule = z.infer<typeof adrRuleSchema>;
export type RuleSeverity = AdrRule["severity"];
