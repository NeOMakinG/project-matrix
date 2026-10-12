import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@matrix/config";
import { type Answers, findContradictions, sampleAnswers } from "@matrix/packs";
import { checkProject, parseAdr } from "@matrix/rules";
import { describe, expect, test } from "vitest";
import { sandboxTool } from "../../rules/src/toolchain";
import { SECURITY_HEADERS } from "./generate/headers";
import { MAX_SKILL_FILE_BYTES, skillFiles } from "./generate/skills";
import { runInit } from "./init";

const fresh = () => mkdtemp(join(tmpdir(), "matrix-stack-"));
const hasRuleToolchains =
  sandboxTool("go", ["version"], tmpdir(), tmpdir()).status === 0 &&
  sandboxTool("sqlc", ["version"], tmpdir(), tmpdir()).status === 0;
const hasPinnedSqlc =
  spawnSync("sqlc", ["version"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim() === "v1.31.1";

interface Stack {
  name: string;
  answers: Answers;
  files: string[];
  skills: string[];
  /** Commands proving the scaffold builds; run only with MATRIX_E2E=1. */
  e2e: { cwd: string; cmd: string[] }[];
}

const stacks: Stack[] = [
  {
    name: "next",
    answers: { "frontend.bundler": "next" },
    files: ["apps/web/app/page.tsx", "apps/web/next.config.ts", "apps/api/src/index.ts"],
    skills: ["nextjs", "react"],
    e2e: [
      { cwd: ".", cmd: ["bun", "install"] },
      { cwd: "apps/web", cmd: ["bun", "run", "typecheck"] },
      { cwd: ".", cmd: ["bun", "run", "lint"] },
      { cwd: "apps/web", cmd: ["bunx", "next", "build"] },
    ],
  },
  {
    name: "tanstack-start",
    answers: { "backend.kind": "fullstack" },
    files: ["apps/web/src/routes/__root.tsx", "apps/web/src/router.tsx", "apps/web/vite.config.ts"],
    skills: ["tanstack-start", "react"],
    e2e: [
      { cwd: ".", cmd: ["bun", "install"] },
      { cwd: "apps/web", cmd: ["bun", "run", "typecheck"] },
      { cwd: ".", cmd: ["bun", "run", "lint"] },
      { cwd: "apps/web", cmd: ["bun", "run", "build"] },
    ],
  },
  {
    name: "expo",
    answers: { "platforms.targets": ["ios", "android"] },
    files: ["apps/mobile/app/_layout.tsx", "apps/mobile/app.json", "apps/mobile/eas.json"],
    skills: ["expo-react-native"],
    e2e: [
      { cwd: ".", cmd: ["bun", "install"] },
      { cwd: "apps/mobile", cmd: ["bun", "run", "typecheck"] },
      { cwd: ".", cmd: ["bun", "run", "lint"] },
      { cwd: "apps/mobile", cmd: ["bunx", "expo", "config", "--json"] },
      { cwd: "apps/mobile", cmd: ["bunx", "expo", "export", "--platform", "web"] },
    ],
  },
  {
    name: "tauri",
    answers: { "platforms.targets": ["desktop"] },
    files: [
      "apps/desktop/src-tauri/tauri.conf.json",
      "apps/desktop/src-tauri/src/lib.rs",
      "apps/desktop/src-tauri/capabilities/default.json",
    ],
    skills: ["tauri", "react"],
    e2e: [
      { cwd: ".", cmd: ["bun", "install"] },
      { cwd: "apps/desktop", cmd: ["bun", "run", "typecheck"] },
      { cwd: ".", cmd: ["bun", "run", "lint"] },
      { cwd: "apps/desktop", cmd: ["bun", "run", "build"] },
      { cwd: "apps/desktop", cmd: ["bun", "run", "check:rust"] },
    ],
  },
  {
    name: "go",
    answers: { "backend.kind": "go" },
    files: ["services/api/go.mod", "services/api/cmd/api/main.go", "services/api/sqlc.yaml"],
    skills: ["go"],
    e2e: [
      { cwd: "services/api", cmd: ["go", "build", "-mod=mod", "./..."] },
      { cwd: "services/api", cmd: ["go", "vet", "./..."] },
      { cwd: "services/api", cmd: ["golangci-lint", "run"] },
    ],
  },
];

const init = async (s: Stack) => {
  const out = await fresh();
  const r = await runInit({
    answers: { ...sampleAnswers, ...s.answers },
    outDir: out,
    acceptRecommended: true,
    scaffold: true,
    date: "2026-10-12",
  });
  return { out, r };
};

describe.each(stacks)("stack pack: $name", (s) => {
  test("interview resolves without contradictions and scaffolds the stack", async () => {
    const { r } = await init(s);
    expect(r.status, JSON.stringify(r)).toBe("ok");
    if (r.status !== "ok") return;
    for (const f of s.files) expect(r.files).toContain(f);
    const config = parseConfig(r.config);
    for (const k of s.skills) {
      expect(config.agents.skills).toContain(k);
      expect(r.files).toContain(`.claude/skills/${k}/SKILL.md`);
    }
  });

  test.runIf(process.env.MATRIX_E2E === "1")(
    "generated scaffold installs and builds",
    async () => {
      const { out, r } = await init(s);
      expect(r.status).toBe("ok");
      const qaTemp = join(out, ".qa-tmp");
      await mkdir(qaTemp);
      for (const step of s.e2e) {
        const [bin, ...args] = step.cmd;
        const res = spawnSync(bin ?? "", args, {
          cwd: join(out, step.cwd),
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            CI: "1",
            EXPO_NO_TELEMETRY: "1",
            TMPDIR: qaTemp,
            BUN_INSTALL_CACHE_DIR: join(qaTemp, "bun-cache"),
          },
        });
        expect(
          res.status,
          `${step.cmd.join(" ")}:\n${res.error?.message ?? ""}\n${res.stdout}\n${res.stderr}`,
        ).toBe(0);
        console.info(`${s.name}: ${step.cmd.join(" ")} passed`);
      }
    },
    1_800_000,
  );
});

describe("stack-specific details", () => {
  test.each(["pgx", "database-sql"])("untouched %s init includes sqlc output", async (driver) => {
    const { out, r } = await init({
      ...(stacks.find((stack) => stack.name === "go") as Stack),
      answers: { "backend.kind": "go", "backend.go.driver": driver },
    });
    expect(r.status).toBe("ok");
    const dir = join(out, "services/api/internal/db");
    expect((await readdir(dir)).filter((file) => file.endsWith(".go")).sort()).toEqual([
      "db.go",
      "models.go",
      "queries.sql.go",
    ]);
    const main = await readFile(join(out, "services/api/cmd/api/main.go"), "utf8");
    expect(main).not.toContain("database/sql");
    expect(main).not.toContain("github.com/jackc/pgx");
  });

  test.runIf(hasPinnedSqlc).each(["pgx", "database-sql"])(
    "bundled %s output byte matches pinned sqlc from trusted starter inputs",
    async (driver) => {
      const { out } = await init({
        ...(stacks.find((stack) => stack.name === "go") as Stack),
        answers: { "backend.kind": "go", "backend.go.driver": driver },
      });
      const isolated = await fresh();
      await mkdir(join(isolated, "internal/db"), { recursive: true });
      for (const file of ["sqlc.yaml", "internal/db/schema.sql", "internal/db/queries.sql"])
        await writeFile(join(isolated, file), await readFile(join(out, "services/api", file)));
      const generated = spawnSync("sqlc", ["generate"], {
        cwd: isolated,
        env: { PATH: process.env.PATH, HOME: isolated, TMPDIR: isolated },
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      expect(generated.status, generated.stderr).toBe(0);
      const files = (await readdir(join(isolated, "internal/db")))
        .filter((file) => file.endsWith(".go"))
        .sort();
      expect(files).toEqual(["db.go", "models.go", "queries.sql.go"]);
      for (const file of files)
        expect(await readFile(join(out, "services/api/internal/db", file))).toEqual(
          await readFile(join(isolated, "internal/db", file)),
        );
    },
  );

  test.runIf(hasRuleToolchains).each(["pgx", "database-sql"])(
    "untouched %s init passes matrix check before any regeneration",
    async (driver) => {
      const { out } = await init({
        ...(stacks.find((stack) => stack.name === "go") as Stack),
        answers: { "backend.kind": "go", "backend.go.driver": driver },
      });
      const checked = await checkProject(out);
      expect(checked.invalid).toEqual([]);
      expect(checked.failures).toEqual([]);
      expect(checked.violations).toEqual([]);
      expect(checked.ok).toBe(true);
    },
    30_000,
  );

  test("sqlc exempts only byte-verified generated output, never handwritten bootstrap", async () => {
    const { out, r } = await init(stacks.find((stack) => stack.name === "go") as Stack);
    if (r.status !== "ok") throw new Error(r.status);
    const checks = (
      await Promise.all(
        r.files
          .filter((file) => file.startsWith("docs/adr/"))
          .map(async (file) => parseAdr(file, await readFile(join(out, file), "utf8"))),
      )
    ).flatMap((adr) => adr?.rules.map(({ rule }) => rule.check) ?? []);
    const imports = checks.find(
      (check) => check?.type === "go-imports" && check.import.includes("database/sql"),
    );
    expect(imports?.except).toEqual(["services/api/internal/db/*.go"]);
    const calls = checks.find((check) => check?.type === "go-db-calls");
    expect(calls).toEqual({
      type: "go-db-calls",
      files: ["**/*.go"],
      except: ["services/api/internal/db/*.go"],
    });
    expect(checks.some((check) => check?.type === "sqlc-generated")).toBe(true);
  });
  test("Go CI fails closed on denied sandbox provisioning without disabling host security", async () => {
    const { out } = await init(stacks.find((stack) => stack.name === "go") as Stack);
    const workflow = await readFile(join(out, ".github/workflows/ci.yml"), "utf8");
    const sandboxStep = workflow.slice(
      workflow.indexOf("- name: Verify offline rule toolchain sandbox"),
      workflow.indexOf("- uses: actions/setup-go"),
    );
    expect(sandboxStep).toContain("command -v bwrap");
    expect(sandboxStep).toContain("bwrap --die-with-parent --unshare-all --ro-bind / /");
    expect(sandboxStep).toContain("executable-scoped sandbox policy");
    expect(sandboxStep).toContain("exit 1");
    expect(sandboxStep).not.toContain("sudo");
    expect(workflow).not.toContain("sysctl");
    expect(workflow).not.toContain("apparmor_restrict_unprivileged_userns");
  });
  test("Go API gets OpenAPI client, Clerk auth and no TypeScript ORM", async () => {
    const { r } = await init(stacks.find((s) => s.name === "go") as Stack);
    if (r.status !== "ok") throw new Error(r.status);
    const c = parseConfig(r.config);
    expect(c.backend.go?.router).toBe("chi");
    expect(c.backend.orm).toBe("none");
    expect(c.backend.auth).toBe("clerk");
    expect(c.frontend?.framework === "react" && c.frontend.api).toBe("openapi-fetch");
  });

  test("TanStack Start without a separate backend uses server functions", async () => {
    const { r } = await init(stacks.find((s) => s.name === "tanstack-start") as Stack);
    if (r.status !== "ok") throw new Error(r.status);
    const c = parseConfig(r.config);
    expect(c.frontend?.framework === "react" && c.frontend.api).toBe("server-functions");
    expect(c.frontend?.framework === "react" && c.frontend.router).toBe("tanstack-router");
  });

  test("Tauri capabilities stay least-privilege and the CSP is strict", async () => {
    const { out, r } = await init(stacks.find((s) => s.name === "tauri") as Stack);
    if (r.status !== "ok") throw new Error(r.status);
    const caps = JSON.parse(
      await readFile(join(out, "apps/desktop/src-tauri/capabilities/default.json"), "utf8"),
    );
    expect(caps.permissions).toEqual(["core:default", "updater:default"]);
    const conf = JSON.parse(
      await readFile(join(out, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    );
    expect(conf.app.security.csp).toContain("default-src 'self'");
  });

  test("hostile business names stay inert in Go, TOML and YAML outputs", async () => {
    const name = 'Evil"; os.Exit(1) //\n[package]\n- launchApp';
    const out = await fresh();
    const r = await runInit({
      answers: {
        ...sampleAnswers,
        "business.name": name,
        "platforms.targets": ["ios", "desktop"],
        "backend.kind": "go",
      },
      outDir: out,
      acceptRecommended: true,
      scaffold: true,
    });
    expect(r.status, JSON.stringify(r)).toBe("ok");
    const maestro = await readFile(join(out, "apps/mobile/.maestro/smoke.yaml"), "utf8");
    expect(maestro).toContain(`text: ${JSON.stringify(name)}`);
    const conf = JSON.parse(
      await readFile(join(out, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    );
    expect(conf.productName).toBe(name);
  });
});

describe("ADR rules of every stack", () => {
  test.runIf(hasRuleToolchains)(
    "all rule blocks are valid and enforced, and Go/Tauri rules catch violations",
    async () => {
      const started = performance.now();
      const out = await fresh();
      const r = await runInit({
        answers: {
          ...sampleAnswers,
          "platforms.targets": ["web", "ios", "android", "desktop"],
          "backend.kind": "go",
        },
        outDir: out,
        acceptRecommended: true,
        scaffold: true,
      });
      expect(r.status).toBe("ok");
      const scaffolded = performance.now();
      const untouched = await checkProject(out);
      expect(untouched.invalid).toEqual([]);
      expect(untouched.failures).toEqual([]);
      expect(untouched.violations).toEqual([]);
      expect(untouched.ok).toBe(true);
      await writeFile(
        join(out, "services/api/internal/db/schema.sql"),
        "CREATE TABLE health (id bigint primary key);\n",
      );
      await writeFile(
        join(out, "services/api/internal/db/queries.sql"),
        "-- name: GetHealth :one\nSELECT id FROM health WHERE id = $1;\n",
      );
      expect(sandboxTool("sqlc", ["generate"], join(out, "services/api"), out).status).toBe(0);
      const generated = performance.now();
      const clean = await checkProject(out);
      const checkedClean = performance.now();
      expect(clean.invalid).toEqual([]);
      expect(clean.failures).toEqual([]);
      expect(clean.ok).toBe(true);
      const bootstrapPath = "services/api/cmd/api/main.go";
      const bootstrap = await readFile(join(out, bootstrapPath), "utf8");

      // Each file is one bypass reported by review; every one must be caught.
      const bypasses: Record<string, string> = {
        "services/api/cmd/api/queries.go":
          'package main\nimport ("context"; "github.com/jackc/pgx/v5")\nfunc rawQueries(conn *pgx.Conn, ctx context.Context) { _, _ = conn.Exec(ctx, "SELECT 1") }\n',
        [bootstrapPath]:
          bootstrap.replace(
            '"context"',
            '"context"\n"database/sql"\n"github.com/jackc/pgx/v5"\n"github.com/jackc/pgx/v5/pgconn"',
          ) +
          '\nfunc rawBootstrap(conn *pgx.Conn, db *sql.DB, ctx context.Context, query string) {\n _, _ = conn.Exec(ctx, "SELECT 1")\n _, _ = conn.Query(ctx, `SELECT $1`, 1)\n _ = conn.QueryRow(ctx, query)\n _, _ = db.ExecContext(ctx, query)\n _, _ = db.QueryContext(ctx, "SELECT 1")\n _ = db.QueryRowContext(ctx, query)\n execute := conn.Exec\n _, _ = execute(ctx, "SELECT 1")\n}\nfunc rawProtocol(conn *pgconn.PgConn, ctx context.Context, query string) {\n conn.ExecParams(ctx, "DELETE FROM t", nil, nil, nil, nil).Close()\n conn.ExecPrepared(ctx, query, nil, nil, nil).Close()\n var batch pgconn.Batch\n batch.ExecParams("DELETE FROM t", nil, nil, nil, nil)\n conn.ExecBatch(ctx, &batch).Close()\n conn.CopyFrom(ctx, nil, query)\n conn.CopyTo(ctx, nil, "COPY t TO STDOUT")\n}\nfunc rawBatch(conn *pgx.Conn, ctx context.Context) {\n var batch pgx.Batch\n batch.Queue("DELETE FROM t")\n conn.SendBatch(ctx, &batch).Close()\n conn.CopyFrom(ctx, pgx.Identifier{"t"}, nil, nil)\n}\n',
        "services/api/internal/httpapi/router_gin.go":
          'package httpapi\n\nimport "github.com/gin-gonic/gin"\n\nvar _ = gin.New\n',
        "services/api/internal/httpapi/backtick.go":
          "package httpapi\n\nimport sqlx `database/sql`\n\nvar _ sqlx.DB\n",
        "services/api/internal/httpapi/grouped.go":
          'package httpapi\n\nimport (\n\t"context"\n\tp "github.com/jackc/pgx/v5/pgxpool"\n)\n\nvar _ = context.TODO\nvar _ *p.Pool\n',
        "services/api/internal/httpapi/forged.go":
          '// Code generated by sqlc. DO NOT EDIT.\npackage httpapi\n\nimport "database/sql"\n\nvar _ sql.DB\n',
        "services/api/internal/db/handwritten.go":
          'package db\n\nimport "database/sql"\n\nvar _ sql.DB\n',
        "services/api/internal/db/nested/x.go":
          'package nested\n\nimport "database/sql"\n\nvar _ sql.DB\n',
        "services/api/internal/httpapi/concat.go":
          'package httpapi\n\nfunc q(db interface{ Exec(string) }, id string) {\n\tdb.Exec("DELETE FROM t WHERE id=" + id)\n}\n',
        "services/api/internal/httpapi/sprintf.go":
          'package httpapi\n\nimport "fmt"\n\nfunc q(db interface{ Query(string) }, id string) {\n\tdb.Query(fmt.Sprintf("SELECT %s", id))\n}\n',
        "services/api/internal/httpapi/oldlog.go":
          'package httpapi\n\nimport stdlog "log"\n\nfunc l() { stdlog.Println("x") }\n',
        "apps/desktop/src-tauri/capabilities/exec.json":
          '{"identifier":"a","windows":["main"],"permissions":["shell:allow-execute"]}\n',
        "apps/desktop/src-tauri/capabilities/readall.json":
          '{"identifier":"b","windows":["main"],"permissions":["fs:read-all"]}\n',
        "apps/desktop/src-tauri/capabilities/escaped.json":
          '{"identifier":"c","windows":["main"],"permissions":["\\u0073hell:allow-spawn"]}\n',
        // Round 2 payloads.
        "services/api/internal/httpapi/unicode.go":
          'package httpapi\n\nimport 数据库 "database/sql"\n\nvar _ 数据库.DB\n',
        "services/api/internal/httpapi/octal.go": 'package httpapi\n\nimport "database\\057sql"\n',
        "services/api/internal/httpapi/glued.go":
          'package httpapi\n\nimport/*x*/db "database/sql"\n\nvar _ db.DB\n',
        "services/api/internal/httpapi/builder.go":
          "package httpapi\n\nfunc run(d interface{ Query(string) }, q string) { d.Query(q) }\n",
        "services/api/internal/db/fakegen.go":
          '// Code generated by sqlc. DO NOT EDIT.\npackage db\n\nimport "database/sql"\n\nvar _ sql.DB\n',
        "services/storage/go.mod": "module example.com/storage\n\ngo 1.24\n",
        "services/storage/access.go": 'package storage\n\nimport "database/sql"\n\nvar _ sql.DB\n',
        "apps/desktop/src-tauri/capabilities/caps.toml":
          'identifier = "t"\nwindows = ["main"]\npermissions = ["shell:allow-execute"]\n',
        "apps/desktop/src-tauri/capabilities/caps.json5":
          "{ identifier: 'j', windows: ['main'], permissions: ['shell:allow-execute'] }\n",
        "apps/desktop/src-tauri/capabilities/home.json":
          '{"identifier":"d","windows":["main"],"permissions":[{"identifier":"core:default","allow":[{"path":"$HOME/**"}]}]}\n',
      };
      const rawFamilies = [
        ["params", 'conn.ExecParams(ctx, "DELETE FROM t", nil, nil, nil, nil).Close()'],
        ["prepared", "conn.ExecPrepared(ctx, query, nil, nil, nil).Close()"],
        ["batch", "conn.ExecBatch(ctx, &pgconn.Batch{}).Close()"],
        ["copyfrom", "conn.CopyFrom(ctx, nil, query)"],
        ["copyto", 'conn.CopyTo(ctx, nil, "COPY t TO STDOUT")'],
      ];
      for (const [name, call] of rawFamilies)
        bypasses[`services/api/cmd/api/${name}.go`] =
          `package main\nimport ("context"; "github.com/jackc/pgx/v5/pgconn")\nfunc ${name}(conn *pgconn.PgConn, ctx context.Context, query string) { ${call} }\n`;
      for (const [file, text] of Object.entries(bypasses)) {
        await mkdir(join(out, file, ".."), { recursive: true });
        await writeFile(join(out, file), text);
      }
      const dirty = await checkProject(out);
      const checkedDirty = performance.now();
      for (const file of [
        bootstrapPath,
        ...rawFamilies.map(([name]) => `services/api/cmd/api/${name}.go`),
      ])
        expect(dirty.violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ file, message: 'imports "github.com/jackc/pgx/v5/pgconn"' }),
          ]),
        );
      console.info("ADR validation phase timings (ms)", {
        scaffold: Math.round(scaffolded - started),
        sqlcFixture: Math.round(generated - scaffolded),
        cleanCheck: Math.round(checkedClean - generated),
        dirtyCheckAndFixtures: Math.round(checkedDirty - checkedClean),
      });
      expect(dirty.ok).toBe(false);
      const flagged = new Set(dirty.violations.map((v) => v.file));
      for (const file of Object.keys(bypasses).filter((f) => !f.endsWith("go.mod")))
        expect(flagged, file).toContain(file);
      expect(dirty.invalid).toEqual([]);
      expect(dirty.failures).toEqual([]);
      expect(dirty.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: "services/api/cmd/api/queries.go",
            message: 'imports "github.com/jackc/pgx/v5"',
          }),
        ]),
      );
      for (const method of [
        "Query",
        "QueryRow",
        "Exec",
        "QueryContext",
        "QueryRowContext",
        "ExecContext",
      ]) {
        expect(dirty.violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: bootstrapPath,
              message: `raw database method reference ${method} is allowed only in verified sqlc output`,
            }),
          ]),
        );
      }
      for (const file of [
        "services/api/internal/httpapi/unicode.go",
        "services/api/internal/httpapi/octal.go",
        "services/api/internal/httpapi/glued.go",
        "services/storage/access.go",
      ]) {
        expect(dirty.violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ file, line: 3, message: 'imports "database/sql"' }),
          ]),
        );
      }
      for (const file of [
        "apps/desktop/src-tauri/capabilities/caps.toml",
        "apps/desktop/src-tauri/capabilities/caps.json5",
      ]) {
        expect(dirty.violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file,
              message: "shell:allow-execute is a dangerous permission family",
            }),
          ]),
        );
      }
    },
    30_000,
  );
});

describe("PR #24 review P2 hardening", () => {
  test("skill directory symlinks cannot bypass file safety checks", async () => {
    const dir = await fresh();
    const outside = await fresh();
    await writeFile(join(outside, "SKILL.md"), "external");
    await symlink(outside, join(dir, "linked"));
    await expect(skillFiles(["linked"], dir)).rejects.toThrow("regular directory");
  });
  test("Next.js and TanStack Start send security headers", async () => {
    for (const [name, file] of [
      ["next", "apps/web/next.config.ts"],
      ["tanstack-start", "apps/web/src/start.ts"],
    ] as const) {
      const { out, r } = await init(stacks.find((s) => s.name === name) as Stack);
      expect(r.status).toBe("ok");
      const text = await readFile(join(out, file), "utf8");
      for (const header of Object.keys(SECURITY_HEADERS))
        expect(text, `${name}: ${header}`).toContain(header);
      expect(text).toContain("frame-ancestors 'none'");
    }
  });

  test("Go server sets read, write, idle and header timeouts", async () => {
    const { out } = await init(stacks.find((s) => s.name === "go") as Stack);
    const main = await readFile(join(out, "services/api/cmd/api/main.go"), "utf8");
    for (const t of ["ReadHeaderTimeout", "ReadTimeout", "WriteTimeout", "IdleTimeout"])
      expect(main).toContain(t);
  });

  test("names starting with a digit still give valid crate, package and bundle identifiers", async () => {
    const out = await fresh();
    const r = await runInit({
      answers: {
        ...sampleAnswers,
        "business.name": "42 Labs",
        "platforms.targets": ["ios", "desktop"],
      },
      outDir: out,
      acceptRecommended: true,
      scaffold: true,
    });
    expect(r.status).toBe("ok");
    const cargo = await readFile(join(out, "apps/desktop/src-tauri/Cargo.toml"), "utf8");
    for (const m of cargo.matchAll(/^name = "([^"]+)"/gm))
      expect(m[1]).toMatch(/^[a-z][a-z0-9_]*$/);
    const conf = JSON.parse(
      await readFile(join(out, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    );
    const app = JSON.parse(await readFile(join(out, "apps/mobile/app.json"), "utf8")).expo;
    for (const id of [conf.identifier, app.android.package, app.ios.bundleIdentifier])
      for (const seg of String(id).split(".")) expect(seg, id).toMatch(/^[a-z][a-z0-9]*$/);
    expect(app.scheme).toMatch(/^[a-z][a-z0-9]*$/);
  });

  test("oversized skill files are refused before reading", async () => {
    const dir = await fresh();
    await mkdir(join(dir, "big"), { recursive: true });
    await writeFile(join(dir, "big/SKILL.md"), "x".repeat(MAX_SKILL_FILE_BYTES + 1));
    await expect(skillFiles(["big"], dir)).rejects.toThrow(/under/);
  });
});

describe("new contradiction rules", () => {
  const ids = (a: Answers) => findContradictions({ ...sampleAnswers, ...a }).map((c) => c.id);
  test.each([
    [
      { "frontend.bundler": "next", "frontend.router": "tanstack-router" },
      "next-without-app-router",
    ],
    [
      { "frontend.bundler": "vite", "frontend.router": "next-app-router" },
      "app-router-without-next",
    ],
    [
      { "frontend.bundler": "tanstack-start", "frontend.router": "react-router" },
      "start-without-tanstack-router",
    ],
    [
      { "frontend.bundler": "vite", "frontend.api": "server-functions" },
      "server-functions-without-fullstack",
    ],
    [{ "backend.kind": "go", "frontend.api": "trpc" }, "trpc-with-go"],
    [{ "backend.kind": "go", "backend.orm": "drizzle" }, "ts-library-with-go"],
    [
      { "desktop.distribution": "app-stores", "desktop.signing": [] },
      "store-distribution-unsigned",
    ],
    [
      { "agents.workspace": "native", "agents.browserDriver": "orca-browser" },
      "orca-driver-without-orca",
    ],
  ])("%j → %s", (answers, id) => {
    expect(ids(answers as Answers)).toContain(id);
  });
});
