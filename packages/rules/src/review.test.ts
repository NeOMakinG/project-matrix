import { spawnSync } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { fixtureProject } from "../../graph/src/test-utils";
import { checkProject } from "./engine";
import { adrMarkdown, runRuleCase } from "./harness";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};

const put = async (root: string, rel: string, text: string) => {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), text);
};

const ormAdr = adrMarkdown("0023", "ORM", [
  {
    description: "Only src/db may import drizzle-orm.",
    check: { type: "forbidden-import", import: "^drizzle-orm", except: ["src/db/**"] },
  },
]);

describe("P1-1 rules come from the base commit, not the code under check", () => {
  test("a capability change cannot widen its own ADR allowlist", async () => {
    const policy = (allow: string[]) =>
      adrMarkdown("0024", "Capabilities", [
        {
          description: "Only approved permissions.",
          check: { type: "tauri-capabilities", allow },
        },
      ]);
    const root = await fixtureProject({
      "docs/adr/0024-capabilities.md": policy(["core:default"]),
      "desktop/tauri.conf.json": "{}",
      "desktop/capabilities/default.json":
        '{"identifier":"default","permissions":["core:default"]}',
    });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    await put(root, "docs/adr/0024-capabilities.md", policy(["core:default", "http:default"]));
    await put(
      root,
      "desktop/capabilities/default.json",
      '{"identifier":"default","permissions":["http:default"]}',
    );
    expect((await checkProject(root)).ok).toBe(true);
    const gated = await checkProject(root, { rulesFrom: "main" });
    expect(gated.ok).toBe(false);
    expect(gated.violations[0]?.message).toContain("not on the ADR allow-list");
  });
  test("superseding or deleting an ADR in the branch does not disable its rule", async () => {
    const root = await fixtureProject({
      "docs/adr/0023-orm.md": ormAdr,
      "src/db/client.ts": 'import { drizzle } from "drizzle-orm";\nexport const db = drizzle;\n',
    });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "feature");
    await put(root, "docs/adr/0023-orm.md", ormAdr.replace("accepted", "superseded"));
    await put(root, "src/leak.ts", 'import { eq } from "drizzle-orm";\nexport const x = eq;\n');

    const local = await checkProject(root);
    expect(local.ok).toBe(true);

    const gated = await checkProject(root, { rulesFrom: "main" });
    expect(gated.ok).toBe(false);
    expect(gated.violations.map((v) => `${v.adr} ${v.file}:${v.line}`)).toEqual([
      "ADR-0023 src/leak.ts:1",
    ]);
    expect(gated.rulesSource.kind).toBe("git");
    expect(gated.adrChanges).toEqual([{ file: "docs/adr/0023-orm.md", change: "modified" }]);
    expect(gated.requiresReview).toBe(true);

    await rm(join(root, "docs/adr/0023-orm.md"));
    await rm(join(root, "src/leak.ts"));
    const removed = await checkProject(root, { rulesFrom: "main" });
    expect(removed.failures.join("\n")).toMatch(/drops enforced ADR rules from 1 to 0/);
    expect((await checkProject(root, { rulesFrom: "main", allowRuleRemoval: true })).ok).toBe(true);
  });
});

describe("P1-2 boundaries see through package names, aliases and every import form", () => {
  test("workspace package, tsconfig paths, export-from, import(), require(), computed", async () => {
    const r = await runRuleCase({
      rules: [
        {
          description: "Web never imports API server code.",
          check: { type: "boundary", files: ["apps/web/**"], disallow: ["apps/api/**"] },
        },
      ],
      files: {
        "apps/api/package.json": '{ "name": "ledgerly-api" }',
        "apps/api/src/db/schema.ts": "export const users = 1;\n",
        "apps/web/tsconfig.json":
          '{ "compilerOptions": { "baseUrl": ".", "paths": { "@api/*": ["../api/src/*"] } } }',
        "apps/web/src/a.ts": 'export * from "ledgerly-api/src/db/schema";\n',
        "apps/web/src/b.ts": 'import { users } from "@api/db/schema";\nexport const b = users;\n',
        "apps/web/src/c.ts": 'export const c = () => import("../../api/src/db/schema");\n',
        "apps/web/src/d.js": 'const s = require("ledgerly-api/src/db/schema");\n',
        "apps/web/src/e.ts": "export const e = (p: string) => import(p);\n",
      },
    });
    expect(r.hits).toEqual([
      "ADR-0099 apps/web/src/a.ts:1",
      "ADR-0099 apps/web/src/b.ts:1",
      "ADR-0099 apps/web/src/c.ts:1",
      "ADR-0099 apps/web/src/d.js:1",
      "ADR-0099 apps/web/src/e.ts:1",
    ]);
    expect(r.violations.find((v) => v.file.endsWith("e.ts"))?.severity).toBe("warning");
  });
});

describe("P1-3 nothing is hidden by folder names or symlinks", () => {
  test("build/, dist/ and coverage/ at depth are checked; escaping symlinks fail", async () => {
    const outside = await fixtureProject({ "x.ts": 'import "drizzle-orm";\n' });
    const root = await fixtureProject({
      "docs/adr/0023-orm.md": ormAdr,
      "src/build/hidden.ts": 'import "drizzle-orm";\n',
      "src/dist/also.ts": 'import "drizzle-orm";\n',
    });
    await symlink(join(outside, "x.ts"), join(root, "src/escape.ts"));
    const r = await checkProject(root);
    expect(r.violations.map((v) => v.file)).toEqual(["src/build/hidden.ts", "src/dist/also.ts"]);
    expect(r.failures).toEqual([expect.stringMatching(/symlink src\/escape.ts points outside/)]);
    expect(r.ok).toBe(false);
  });
});

describe("P1-4 missing rules fail closed", () => {
  test("a Matrix project without ADR rules fails; a manifest minimum is enforced", async () => {
    const bare = await fixtureProject({
      "matrix.config.ts": "export default {};\n",
      "src/a.ts": "",
    });
    const r = await checkProject(bare);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/no enforced ADR rules loaded/);

    const shrunk = await fixtureProject({
      "docs/adr/0023-orm.md": ormAdr,
      ".matrix/rules-manifest.json": '{ "version": 1, "adrDir": "docs/adr", "minRules": 2 }',
      "src/a.ts": "",
    });
    const s = await checkProject(shrunk);
    expect(s.failures[0]).toMatch(/only 1 enforced ADR rules loaded .* requires 2/);
  });
});

describe("P2 hardening", () => {
  test("call-pattern catches aliases, globalThis/window access and fetch.call", async () => {
    const r = await runRuleCase({
      rules: [
        {
          description: "No fetch() outside src/api.",
          check: { type: "call-pattern", pattern: "fetch($$$)" },
        },
      ],
      files: {
        "src/a.ts": [
          "const f = fetch;",
          'f("/1");',
          'globalThis.fetch("/2");',
          'window["fetch"]("/3");',
          'fetch.call(null, "/4");',
          '(globalThis as any).fetch("/5");',
          "const client = { fetch: (x: number) => x };",
          "client.fetch(1);",
        ].join("\n"),
      },
    });
    expect(r.hits).toEqual([
      "ADR-0099 src/a.ts:2",
      "ADR-0099 src/a.ts:3",
      "ADR-0099 src/a.ts:4",
      "ADR-0099 src/a.ts:5",
      "ADR-0099 src/a.ts:6",
    ]);
  });

  test("catastrophic-backtracking regexes are rejected as invalid rules", async () => {
    const r = await runRuleCase({
      rules: [{ description: "bad", check: { type: "regex", pattern: "(a+)+$" } }],
      files: { "a.ts": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!" },
    });
    expect(r.ok).toBe(false);
    expect(r.invalid[0]?.message).toMatch(/unsafe regex/);
  });
});

describe("round 2", () => {
  test("P2: this.method(...) call patterns match again", async () => {
    const r = await runRuleCase({
      rules: [
        {
          description: "No raw SQL execution outside repositories.",
          check: { type: "call-pattern", pattern: "this.execute($$$)" },
        },
      ],
      files: {
        "src/svc.ts": [
          "class Svc {",
          "  execute(q: string) { return q; }",
          '  run() { return this.execute("select 1"); }',
          "}",
          'new Svc().execute("x");',
        ].join("\n"),
      },
    });
    expect(r.hits).toEqual(["ADR-0099 src/svc.ts:3"]);
  });
});

describe("round 2: submodules", () => {
  const subGit = (cwd: string, ...args: string[]) =>
    git(cwd, "-c", "protocol.file.allow=always", ...args);

  const setup = async (manifest?: object) => {
    const lib = await fixtureProject({
      "x.ts": 'import { eq } from "drizzle-orm";\nexport const x = eq;\n',
    });
    git(lib, "init", "-q", "-b", "main");
    git(lib, "add", ".");
    git(lib, "commit", "-q", "-m", "lib");
    const root = await fixtureProject({
      "docs/adr/0023-orm.md": ormAdr,
      "src/a.ts": "export const a = 1;\n",
      ...(manifest ? { ".matrix/rules-manifest.json": JSON.stringify(manifest) } : {}),
    });
    git(root, "init", "-q", "-b", "main");
    subGit(root, "submodule", "add", "-q", lib, "vendor/lib");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    return root;
  };

  test("P1: a populated submodule fails closed instead of hiding its code", async () => {
    const r = await checkProject(await setup());
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([expect.stringMatching(/submodule vendor\/lib hides code/)]);
    expect(r.violations).toEqual([]);
  });

  test("P1: an allowed submodule is checked recursively", async () => {
    const r = await checkProject(
      await setup({ version: 1, adrDir: "docs/adr", minRules: 1, allowSubmodules: ["vendor/*"] }),
    );
    expect(r.failures).toEqual([]);
    expect(r.violations.map((v) => `${v.adr} ${v.file}:${v.line}`)).toEqual([
      "ADR-0023 vendor/lib/x.ts:1",
    ]);
  });

  test("P1: an allowed but uninitialised submodule fails closed", async () => {
    const root = await setup({
      version: 1,
      adrDir: "docs/adr",
      minRules: 1,
      allowSubmodules: ["vendor/lib"],
    });
    git(root, "submodule", "deinit", "-q", "-f", "vendor/lib");
    const r = await checkProject(root);
    expect(r.failures).toEqual([
      expect.stringMatching(/vendor\/lib is allowed but not checked out/),
    ]);
  });

  test("P1: a branch cannot allow its own submodule when rules come from the base", async () => {
    const root = await setup();
    git(root, "checkout", "-q", "-b", "feat");
    await put(
      root,
      ".matrix/rules-manifest.json",
      JSON.stringify({ version: 1, adrDir: "docs/adr", minRules: 1, allowSubmodules: ["**"] }),
    );
    expect((await checkProject(root)).failures).toEqual([]);
    const gated = await checkProject(root, { rulesFrom: "main" });
    expect(gated.failures).toEqual([expect.stringMatching(/submodule vendor\/lib hides code/)]);
  });

  test("P1: nested repositories are detected outside git too", async () => {
    const root = await fixtureProject({
      "docs/adr/0023-orm.md": ormAdr,
      "vendor/inner/.git/HEAD": "ref: refs/heads/main\n",
      "vendor/inner/x.ts": 'import "drizzle-orm";\n',
    });
    const r = await checkProject(root);
    expect(r.failures).toEqual([expect.stringMatching(/submodule vendor\/inner hides code/)]);
  });
});

describe("round 3", () => {
  test("P1: gitlinks with newline, space and unicode paths (no .gitmodules) are detected", async () => {
    const root = await fixtureProject({
      "docs/adr/0023-orm.md": ormAdr,
      "src/a.ts": "export {};\n",
    });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const sha = git(root, "rev-parse", "HEAD").trim();
    const weird = ["vendor/new\nline", "vendor/with space", "vendor/ünïcode"];
    for (const p of weird) git(root, "update-index", "--add", "--cacheinfo", `160000,${sha},${p}`);
    git(root, "commit", "-q", "-m", "gitlinks");
    const r = await checkProject(root);
    expect(r.ok).toBe(false);
    for (const p of weird)
      expect(r.failures).toContainEqual(expect.stringContaining(`submodule ${p} hides code`));
  });
});
