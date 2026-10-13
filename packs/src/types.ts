import type { RuleCheck } from "@matrix/rules";
export type AnswerValue = string | number | boolean | string[];
export type Answers = Record<string, AnswerValue>;

export type PackId =
  | "business"
  | "product"
  | "platforms"
  | "frontend"
  | "mobile"
  | "desktop"
  | "backend"
  | "hosting"
  | "observability"
  | "quality"
  | "process"
  | "agents"
  | "design";

export interface Option {
  value: string;
  label: string;
  rationale?: string;
}

export interface InferContext {
  /** Dependencies found in package.json files of an existing repo. */
  dependencies: Set<string>;
  /** Relative file paths found in an existing repo (bounded). */
  files: Set<string>;
  env: Record<string, string | undefined>;
}

/** A machine-checkable rule stub attached to an ADR; enforced later by `matrix check`. */
export interface RuleStub {
  engine: "dependency-cruiser" | "ast-grep" | "biome" | "semgrep" | "custom";
  description: string;
  pattern?: string;
  /** Machine-checkable body enforced by `matrix check`. Stubs without one are reported as unenforced. */
  check?: RuleCheck;
}

export interface AdrTemplate {
  /** Short noun phrase, e.g. "server state management". */
  topic: string;
  context: string;
  consequences?: string;
  rules?: (value: AnswerValue, answers: Answers) => RuleStub[];
}

export interface Question {
  id: string;
  pack: PackId;
  prompt: string;
  kind: "select" | "multiselect" | "text" | "list" | "confirm" | "number";
  options?: Option[];
  recommended?: AnswerValue | ((answers: Answers) => AnswerValue);
  rationale?: string;
  /** Question ids that must be answered before this one can be asked. */
  dependsOn?: string[];
  /** Design-tree condition: the question only exists when this returns true. */
  when?: (answers: Answers) => boolean;
  /** Look the fact up instead of asking (existing repo, environment). */
  infer?: (ctx: InferContext) => AnswerValue | undefined;
  /** Dot path in matrix.config this answer writes to. */
  field: string;
  /** Converts the raw answer into the config value. */
  toValue?: (value: AnswerValue, answers: Answers) => unknown;
  /** Significant choices produce an ADR. */
  adr?: AdrTemplate;
}

export interface Pack {
  id: PackId;
  title: string;
  questions: Question[];
}
