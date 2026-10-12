import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@matrix/config";
import { type Answers, findContradictions, sampleAnswers } from "@matrix/packs";
import { checkProject } from "@matrix/rules";
import { describe, expect, test } from "vitest";
import { SECURITY_HEADERS } from "./generate/headers";
import { MAX_SKILL_FILE_BYTES, skillFiles } from "./generate/skills";
import { runInit } from "./init";

const fresh = () => mkdtemp(join(tmpdir(), "matrix-stack-"));

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
      { cwd: "apps/mobile", cmd: ["bunx", "expo", "config", "--json"] },
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
      for (const step of s.e2e) {
        const [bin, ...args] = step.cmd;
        const res = spawnSync(bin ?? "", args, {
          cwd: join(out, step.cwd),
          encoding: "utf8",
          env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" },
        });
        expect(res.status, `${step.cmd.join(" ")}:\n${res.stdout}\n${res.stderr}`).toBe(0);
      }
    },
    1_800_000,
  );
});

describe("stack-specific details", () => {
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
  test("all rule blocks are valid and enforced, and Go/Tauri rules catch violations", async () => {
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
    const clean = await checkProject(out);
    expect(clean.invalid).toEqual([]);
    expect(clean.failures).toEqual([]);
    expect(clean.ok).toBe(true);

    // Each file is one bypass reported by review; every one must be caught.
    const bypasses: Record<string, string> = {
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
      "apps/desktop/src-tauri/capabilities/home.json":
        '{"identifier":"d","windows":["main"],"permissions":[{"identifier":"core:default","allow":[{"path":"$HOME/**"}]}]}\n',
    };
    for (const [file, text] of Object.entries(bypasses)) {
      await mkdir(join(out, file, ".."), { recursive: true });
      await writeFile(join(out, file), text);
    }
    const dirty = await checkProject(out);
    expect(dirty.ok).toBe(false);
    const flagged = new Set(dirty.violations.map((v) => v.file));
    for (const file of Object.keys(bypasses)) expect(flagged, file).toContain(file);
  });
});

describe("PR #24 review P2 hardening", () => {
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
