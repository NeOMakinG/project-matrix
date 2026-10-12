import type { Option, Pack, Question, RuleStub } from "../types";
import { hasGoBackend, opt } from "./helpers";

const GO = ["services/api/**/*.go"];

const regex = (
  description: string,
  pattern: string,
  extra: { except?: string[]; flags?: string } = {},
): RuleStub => ({
  engine: "semgrep",
  description,
  check: { type: "regex", files: GO, pattern, ...extra },
});

/** Structural Go import rule: single, grouped, aliased and raw-string imports all count. */
const imports = (
  description: string,
  importRe: string,
  extra: { files?: string[]; except?: string[]; exceptGenerated?: boolean } = {},
): RuleStub => ({
  engine: "semgrep",
  description,
  check: { type: "go-imports", files: extra.files ?? GO, import: importRe, ...extra },
});

/** sqlc writes its package here; only generated files in this exact folder are exempt. */
const DB_PACKAGE = ["services/api/internal/db/*.go"];
/** The entrypoint wires the connection pool. */
const WIRING = ["services/api/cmd/api/*.go"];

const LOW_LEVEL_DB = "^(database/sql|github\\.com/jackc/pgx)(/|$)";

interface GoChoice {
  key: string;
  prompt: string;
  options: Option[];
  recommended: string;
  rationale: string;
  topic: string;
  context: string;
  rules?: (value: string) => RuleStub[];
}

const choice = (c: GoChoice): Question => ({
  id: `backend.go.${c.key}`,
  pack: "backend",
  kind: "select",
  field: `backend.go.${c.key}`,
  prompt: c.prompt,
  options: c.options,
  recommended: c.recommended,
  rationale: c.rationale,
  dependsOn: ["backend.kind"],
  when: hasGoBackend,
  adr: {
    topic: c.topic,
    context: c.context,
    ...(c.rules ? { rules: (v) => c.rules?.(String(v)) ?? [] } : {}),
  },
});

const ROUTER_IMPORTS: Record<string, string> = {
  chi: "github.com/go-chi/chi",
  echo: "github.com/labstack/echo",
  gin: "github.com/gin-gonic/gin",
};

export const goPack: Pack = {
  id: "backend",
  title: "Backend (Go API)",
  questions: [
    choice({
      key: "router",
      prompt: "Go HTTP router?",
      options: [
        opt("chi", "chi", "net/http compatible, tiny, composable middleware."),
        opt("echo", "Echo", "Batteries included: binding, validation hooks."),
        opt("gin", "Gin", "Most popular, fast, own context type."),
      ],
      recommended: "chi",
      rationale:
        "chi stays on the standard net/http types, so handlers and middleware stay portable.",
      topic: "Go HTTP router",
      context: "One router keeps middleware, error handling and tracing consistent.",
      rules: (v) =>
        Object.entries(ROUTER_IMPORTS)
          .filter(([k]) => k !== v)
          .map(([k, path]) =>
            imports(
              `HTTP routing uses ${v}; ${k} must not be imported.`,
              `^${path.replace(/\./g, "\\.")}(/|$)`,
            ),
          ),
    }),
    choice({
      key: "data",
      prompt: "Go data access?",
      options: [
        opt("sqlc", "sqlc", "Write SQL, generate typed Go. No runtime reflection."),
        opt("ent", "ent", "Schema-as-code graph ORM with codegen."),
        opt("gorm", "GORM", "Classic reflection ORM."),
        opt("none", "None yet"),
      ],
      recommended: "sqlc",
      rationale: "sqlc keeps queries reviewable SQL while giving compile-time types.",
      topic: "Go data access",
      context: "Data access goes through one generated layer so agents don't scatter raw SQL.",
      rules: (v) =>
        v === "sqlc"
          ? [
              imports(
                "Queries live in sqlc-generated code; hand-written code must not use database/sql or pgx directly.",
                LOW_LEVEL_DB,
                { except: [...DB_PACKAGE, ...WIRING] },
              ),
              imports(
                "Only sqlc-generated files may use the low-level driver inside the db package.",
                LOW_LEVEL_DB,
                { files: DB_PACKAGE, exceptGenerated: true },
              ),
              imports("One data layer: no ORM next to sqlc.", "^(gorm\\.io|entgo\\.io)(/|$)"),
              regex(
                "SQL is never built with string concatenation or fmt.Sprintf.",
                '\\.(Query|QueryRow|Exec)(Context)?\\([^)\\n]*(fmt\\.Sprintf|"\\s*\\+|\\+\\s*")',
              ),
            ]
          : v === "gorm"
            ? [imports("One data layer: GORM; no ent next to it.", "^entgo\\.io(/|$)")]
            : v === "ent"
              ? [imports("One data layer: ent; no GORM next to it.", "^gorm\\.io(/|$)")]
              : [],
    }),
    choice({
      key: "driver",
      prompt: "Postgres driver?",
      options: [
        opt("pgx", "pgx/v5", "Native protocol, pooling, COPY, LISTEN/NOTIFY."),
        opt("database-sql", "database/sql + lib/pq"),
      ],
      recommended: "pgx",
      rationale:
        "pgx is faster and exposes Postgres features lib/pq lacks; lib/pq is in maintenance mode.",
      topic: "Postgres driver",
      context: "The driver decides pooling and which Postgres features are reachable.",
      rules: (v) =>
        v === "pgx" ? [imports("Use pgx, not lib/pq.", "^github\\.com/lib/pq(/|$)")] : [],
    }),
    choice({
      key: "telemetry",
      prompt: "Go tracing?",
      options: [opt("opentelemetry", "OpenTelemetry"), opt("none", "None")],
      recommended: "opentelemetry",
      rationale:
        "The prod loop reads traces to find root causes; otelhttp instruments chi/echo/gin.",
      topic: "Go telemetry",
      context: "Traces and slog logs carry the same trace ids into the monitor.",
      rules: () => [
        imports(
          "Logging goes through log/slog (structured, trace-aware), not the old log package.",
          "^log$",
          { exceptGenerated: true },
        ),
        regex("No fmt.Print logging; use log/slog.", "\\bfmt\\.Print"),
      ],
    }),
  ],
};
