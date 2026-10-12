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

/** sqlc output and other generated code may use the low-level packages. */
const GENERATED = ["services/api/internal/db/**"];

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
            regex(
              `HTTP routing uses ${v}; ${k} must not be imported.`,
              `"${path.replace(/\./g, "\\.")}`,
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
              regex(
                "Queries live in sqlc-generated code; handlers must not call database/sql directly.",
                '"database/sql"',
                { except: GENERATED },
              ),
            ]
          : v === "gorm"
            ? [regex("One data layer: GORM; no sqlc/ent next to it.", '"entgo\\.io/ent')]
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
      rules: (v) => (v === "pgx" ? [regex("Use pgx, not lib/pq.", '"github\\.com/lib/pq"')] : []),
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
        regex(
          "Logging goes through log/slog (structured, trace-aware), not the old log package or fmt.Print.",
          "^\\s*(log\\.Print|log\\.Fatal|fmt\\.Print)",
          { flags: "m", except: GENERATED },
        ),
      ],
    }),
  ],
};
