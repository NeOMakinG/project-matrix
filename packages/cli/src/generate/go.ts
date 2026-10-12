import type { MatrixConfig } from "@matrix/config";
import type { Files } from "./docs";
import { goString } from "./escape";

type GoConfig = NonNullable<MatrixConfig["backend"]["go"]>;

/** Module versions for generated Go services. Bumped by the tech-watch loop. */
export const goModules: Record<string, string> = {
  "github.com/go-chi/chi/v5": "v5.2.2",
  "github.com/labstack/echo/v4": "v4.13.4",
  "github.com/gin-gonic/gin": "v1.10.1",
  "github.com/jackc/pgx/v5": "v5.7.5",
};

const routerImport: Record<GoConfig["router"], string> = {
  chi: "github.com/go-chi/chi/v5",
  echo: "github.com/labstack/echo/v4",
  gin: "github.com/gin-gonic/gin",
};

function routerFile(g: GoConfig): string {
  if (g.router === "chi")
    return `package httpapi

import (
\t"encoding/json"
\t"net/http"

\t"github.com/go-chi/chi/v5"
\t"github.com/go-chi/chi/v5/middleware"
)

// New returns the API router. Handlers stay on net/http types (ADR: Go HTTP router).
func New() http.Handler {
\tr := chi.NewRouter()
\tr.Use(middleware.RequestID, middleware.Recoverer)
\tr.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
\t\tw.Header().Set("Content-Type", "application/json")
\t\t_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
\t})
\treturn r
}
`;
  if (g.router === "echo")
    return `package httpapi

import (
\t"net/http"

\t"github.com/labstack/echo/v4"
\t"github.com/labstack/echo/v4/middleware"
)

// New returns the API router (ADR: Go HTTP router).
func New() http.Handler {
\te := echo.New()
\te.HideBanner = true
\te.Use(middleware.RequestID(), middleware.Recover())
\te.GET("/health", func(c echo.Context) error {
\t\treturn c.JSON(http.StatusOK, map[string]string{"status": "ok"})
\t})
\treturn e
}
`;
  return `package httpapi

import (
\t"net/http"

\t"github.com/gin-gonic/gin"
)

// New returns the API router (ADR: Go HTTP router).
func New() http.Handler {
\tgin.SetMode(gin.ReleaseMode)
\tr := gin.New()
\tr.Use(gin.Recovery())
\tr.GET("/health", func(c *gin.Context) {
\t\tc.JSON(http.StatusOK, gin.H{"status": "ok"})
\t})
\treturn r
}
`;
}

const mainFile = (module: string, name: string) => `package main

import (
\t"context"
\t"errors"
\t"log/slog"
\t"net/http"
\t"os"
\t"os/signal"
\t"syscall"
\t"time"

\t"${module}/internal/httpapi"
)

func main() {
\tlogger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", ${goString(name)})
\tslog.SetDefault(logger)

\taddr := ":" + envOr("PORT", "8080")
\tsrv := &http.Server{Addr: addr, Handler: httpapi.New(), ReadHeaderTimeout: 10 * time.Second}

\tctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
\tdefer stop()

\tgo func() {
\t\tslog.Info("listening", "addr", addr)
\t\tif err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
\t\t\tslog.Error("server stopped", "err", err)
\t\t\tos.Exit(1)
\t\t}
\t}()

\t<-ctx.Done()
\tshutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
\tdefer cancel()
\tif err := srv.Shutdown(shutdown); err != nil {
\t\tslog.Error("shutdown", "err", err)
\t}
}

func envOr(key, fallback string) string {
\tif v := os.Getenv(key); v != "" {
\t\treturn v
\t}
\treturn fallback
}
`;

const golangci = `version: "2"
linters:
  enable:
    - bodyclose
    - errorlint
    - gosec
    - misspell
    - noctx
    - revive
    - sloglint
    - unconvert
formatters:
  enable:
    - gofumpt
    - goimports
`;

export function goFiles(c: MatrixConfig, pkg: string): Files {
  const g = c.backend.go;
  if (!g) return {};
  const module = `example.com/${pkg}/api`;
  const requires = [routerImport[g.router]];
  if (g.driver === "pgx") requires.push("github.com/jackc/pgx/v5");
  const files: Files = {
    "services/api/go.mod": `module ${module}

go 1.24

require (
${requires.map((r) => `\t${r} ${goModules[r]}`).join("\n")}
)
`,
    "services/api/cmd/api/main.go": mainFile(module, pkg),
    "services/api/internal/httpapi/router.go": routerFile(g),
    "services/api/.golangci.yml": golangci,
    "services/api/README.md": `# API (Go)

- \`go run ./cmd/api\` starts the server on \`$PORT\` (default 8080).
- \`go build ./... && go vet ./...\` and \`golangci-lint run\` gate every merge.
- Logging uses \`log/slog\` (JSON). Router: ${g.router}. Data: ${g.data}. Driver: ${g.driver}.
`,
  };
  if (g.data === "sqlc")
    files["services/api/sqlc.yaml"] = `version: "2"
sql:
  - engine: postgresql
    schema: internal/db/schema.sql
    queries: internal/db/queries.sql
    gen:
      go:
        package: db
        out: internal/db
        sql_package: ${g.driver === "pgx" ? "pgx/v5" : "database/sql"}
`;
  if (g.data === "sqlc") {
    files["services/api/internal/db/schema.sql"] =
      "-- Tables live here; `sqlc generate` turns queries.sql into typed Go.\n";
    files["services/api/internal/db/queries.sql"] = "-- name: Ping :one\nSELECT 1;\n";
  }
  return files;
}
