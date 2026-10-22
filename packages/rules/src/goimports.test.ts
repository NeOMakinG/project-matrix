import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { goDatabaseCallHits, goImportHits } from "./goimports";
import { sandboxTool } from "./toolchain";

const hasGo = spawnSync("go", ["version"]).status === 0;
const hasSandbox = sandboxTool("go", ["version"], tmpdir(), tmpdir()).status === 0;
const LOW_LEVEL = /^(database\/sql|github\.com\/jackc\/pgx)(\/|$)/;

async function repo(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "matrix-goimp-"));
  for (const [f, text] of Object.entries(files)) {
    await mkdir(join(root, dirname(f)), { recursive: true });
    await writeFile(join(root, f), text);
  }
  return root;
}

const hitsFor = async (root: string, files: string[], scope = { files: ["**/*.go"] }) =>
  goImportHits(
    { root, allFiles: files, text: (f) => readFile(join(root, f), "utf8"), cache: new Map() },
    { ...scope, import: LOW_LEVEL.source },
    LOW_LEVEL,
  );

const GOMOD = "module example.com/t\n\ngo 1.24\n";

describe.runIf(hasGo && hasSandbox)(
  "Go imports from the toolchain (round 2, P1-B and P1-D)",
  () => {
    test("AST rejects literal, dynamic, commented, raw-string and aliased query methods in bootstrap", async () => {
      const file = "services/api/cmd/api/main.go";
      const files = {
        "services/api/go.mod": GOMOD,
        [file]:
          'package main\nimport ("context"; "database/sql")\nfunc main() {}\nfunc raw(db *sql.DB, ctx context.Context, query string) {\n db.Exec("SELECT 1")\n db.Query(`SELECT $1`, 1)\n db.QueryRow(query)\n db.ExecContext/* comment */(ctx, "SELECT 1")\n db.QueryContext(ctx, query)\n db.QueryRowContext(ctx, `SELECT 1`)\n execute := db.Exec\n execute("SELECT 1")\n _ = "db.Exec(\\"SELECT 1\\")"\n // db.Query("not a call")\n}\n',
      };
      const root = await repo(files);
      const hits = await goDatabaseCallHits(
        {
          root,
          allFiles: Object.keys(files),
          text: (path) => readFile(join(root, path), "utf8"),
          cache: new Map(),
        },
        { files: [file] },
      );
      expect(hits.map((hit) => [hit.file, hit.line, hit.message])).toEqual(
        [
          ["Exec", 5],
          ["Query", 6],
          ["QueryRow", 7],
          ["ExecContext", 8],
          ["QueryContext", 9],
          ["QueryRowContext", 10],
          ["Exec", 11],
        ].map(([method, line]) => [
          file,
          line,
          `raw database method reference ${method} is allowed only in verified sqlc output`,
        ]),
      );
    }, 60_000);

    test("connection construction and Ping/Close bootstrap references remain allowed", async () => {
      const file = "services/api/cmd/api/main.go";
      const files = {
        "services/api/go.mod": GOMOD,
        [file]:
          'package main\nimport "database/sql"\nfunc main() { db, err := sql.Open("postgres", ""); if err != nil { return }; defer db.Close(); db.Ping() }\n',
      };
      const root = await repo(files);
      expect(
        await goDatabaseCallHits(
          {
            root,
            allFiles: Object.keys(files),
            text: (path) => readFile(join(root, path), "utf8"),
            cache: new Map(),
          },
          {},
        ),
      ).toEqual([]);
    });
    test("import forms the text parser missed are caught via go list", async () => {
      const files: Record<string, string> = {
        "svc/go.mod": GOMOD,
        "svc/a/unicode.go": 'package a\n\nimport 数据库 "database/sql"\n\nvar _ 数据库.DB\n',
        "svc/b/hex.go": 'package b\n\nimport "database\\x2fsql"\n\nvar _ sql.DB\n'.replace(
          "var _ sql.DB",
          "var _ = 0",
        ),
        "svc/c/octal.go": 'package c\n\nimport "database\\057sql"\n\nvar _ = 0\n',
        "svc/d/glued.go": 'package d\n\nimport/*x*/db "database/sql"\n\nvar _ db.DB\n',
      };
      const root = await repo(files);
      const hits = await hitsFor(root, Object.keys(files));
      const flagged = new Set(hits.map((h) => h.file));
      for (const f of ["svc/a/unicode.go", "svc/b/hex.go", "svc/c/octal.go", "svc/d/glued.go"])
        expect(flagged, f).toContain(f);
    });

    test("every module in the repo is checked, not only services/api", async () => {
      const files: Record<string, string> = {
        "services/api/go.mod": "module example.com/api\n\ngo 1.24\n",
        "services/api/main.go": "package main\n\nfunc main() {}\n",
        "services/storage/go.mod": "module example.com/storage\n\ngo 1.24\n",
        "services/storage/access.go": 'package storage\n\nimport "database/sql"\n\nvar _ sql.DB\n',
      };
      const root = await repo(files);
      const hits = await hitsFor(root, Object.keys(files));
      expect(hits.map((h) => h.file)).toContain("services/storage/access.go");
    });

    test("Go code outside any module and go.work escapes fail closed", async () => {
      const files: Record<string, string> = {
        "loose/x.go": 'package x\n\nimport "database/sql"\n\nvar _ sql.DB\n',
        "go.work": "go 1.24\n\nuse (\n\t./svc\n\t../outside\n)\n",
        "svc/go.mod": GOMOD,
        "svc/ok.go": "package t\n",
      };
      const root = await repo(files);
      const hits = await hitsFor(root, Object.keys(files));
      const messages = hits.map((h) => `${h.file}: ${h.message}`).join("\n");
      expect(messages).toContain("loose/x.go");
      expect(messages).toContain('go.work: go.work uses "../outside"');
    });

    test("build-tag-excluded files are still checked", async () => {
      const files: Record<string, string> = {
        "svc/go.mod": GOMOD,
        "svc/tagged.go":
          '//go:build ignore\n\npackage t\n\nimport "database/sql"\n\nvar _ sql.DB\n',
        "svc/ok.go": "package t\n",
      };
      const root = await repo(files);
      const hits = await hitsFor(root, Object.keys(files));
      expect(hits.map((h) => h.file)).toContain("svc/tagged.go");
    });

    test("an exempt package path is not flagged", async () => {
      const files: Record<string, string> = {
        "svc/go.mod": GOMOD,
        "svc/internal/db/db.go": 'package db\n\nimport "database/sql"\n\nvar _ sql.DB\n',
      };
      const root = await repo(files);
      const hits = await hitsFor(root, Object.keys(files), {
        files: ["**/*.go"],
        except: ["svc/internal/db/*.go"],
      } as never);
      expect(hits).toEqual([]);
    });
  },
);

describe("without the Go toolchain", () => {
  test.runIf(!hasSandbox)("an unavailable sandbox fails closed", async () => {
    const files = { "svc/go.mod": GOMOD, "svc/a.go": "package t\n" };
    const root = await repo(files);
    expect(
      (await hitsFor(root, Object.keys(files))).some((hit) => hit.message.includes("unverifiable")),
    ).toBe(true);
  });
  test("the rule fails as unverifiable instead of passing", async () => {
    const files = { "svc/go.mod": GOMOD, "svc/a.go": "package t\n" };
    const root = await repo(files);
    const PATH = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const hits = await hitsFor(root, Object.keys(files));
      expect(hits[0]?.message).toContain("unverifiable");
    } finally {
      process.env.PATH = PATH;
    }
  });
});
