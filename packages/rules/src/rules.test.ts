import { describe, expect, test } from "vitest";
import { parseAdr } from "./adr";
import { parseCallPattern } from "./checks";
import { adrMarkdown, runRuleCase } from "./harness";
import { formatHuman, toReceipt } from "./report";

describe("forbidden-import", () => {
  const rules = [
    {
      engine: "dependency-cruiser" as const,
      description: "Only src/db may import drizzle-orm.",
      check: {
        type: "forbidden-import" as const,
        files: ["apps/api/src/**"],
        except: ["apps/api/src/db/**"],
        import: "^drizzle-orm",
      },
    },
  ];

  test("flags imports outside the allowed folder, with file:line", async () => {
    const r = await runRuleCase({
      adr: "0023",
      rules,
      files: {
        "apps/api/src/db/client.ts": 'import { drizzle } from "drizzle-orm/node-postgres";\n',
        "apps/api/src/router.ts": '\nimport { eq } from "drizzle-orm";\n',
        "apps/api/src/types.ts": 'import type { InferSelectModel } from "drizzle-orm";\n',
        "apps/web/src/x.ts": 'import "drizzle-orm";\n',
      },
    });
    expect(r.hits).toEqual(["ADR-0023 apps/api/src/router.ts:2"]);
    expect(r.ok).toBe(false);
  });

  test("includeTypeImports also flags type-only imports", async () => {
    const r = await runRuleCase({
      rules: [{ ...rules[0], check: { ...rules[0]!.check, includeTypeImports: true } }],
      files: { "apps/api/src/types.ts": 'import type { X } from "drizzle-orm";\n' },
    });
    expect(r.hits).toEqual(["ADR-0099 apps/api/src/types.ts:1"]);
  });
});

describe("boundary", () => {
  test("blocks relative imports into disallowed folders, honouring allow", async () => {
    const r = await runRuleCase({
      rules: [
        {
          description: "The web app talks to the API through the tRPC router type only.",
          check: {
            type: "boundary",
            files: ["apps/web/src/**"],
            disallow: ["apps/api/src/**"],
            allow: ["apps/api/src/trpc.ts"],
          },
        },
      ],
      files: {
        "apps/web/src/a.ts": 'import { db } from "../../api/src/db/client";\n',
        "apps/web/src/b.ts": 'import { appRouter } from "../../api/src/trpc";\n',
        "apps/api/src/db/client.ts": "export const db = 1;\n",
        "apps/api/src/trpc.ts": "export const appRouter = 1;\n",
      },
    });
    expect(r.hits).toEqual(["ADR-0099 apps/web/src/a.ts:1"]);
  });
});

describe("call-pattern", () => {
  test("matches the callee exactly, in TSX, ignoring other members", async () => {
    const r = await runRuleCase({
      rules: [
        {
          engine: "ast-grep",
          description: "No fetch() inside components.",
          check: {
            type: "call-pattern",
            files: ["apps/web/src/**/*.tsx"],
            except: ["apps/web/src/api/**"],
            pattern: "fetch($$$)",
          },
        },
      ],
      files: {
        "apps/web/src/Page.tsx":
          'export function Page() {\n  const go = () => fetch("/x");\n  client.fetch(1);\n  return <button onClick={go} />;\n}\n',
        "apps/web/src/api/http.tsx": 'export const get = () => fetch("/api");\n',
      },
    });
    expect(r.hits).toEqual(["ADR-0099 apps/web/src/Page.tsx:2"]);
  });

  test("pattern parsing", () => {
    expect(parseCallPattern("fetch($$$)")).toEqual({ callee: "fetch", arity: undefined });
    expect(parseCallPattern("db.execute($A, $B)")).toEqual({ callee: "db.execute", arity: 2 });
    expect(() => parseCallPattern("fetch('x')")).toThrow(/metavariables/);
  });
});

describe("regex and required-header", () => {
  test("regex reports every match line; headers are checked on the first lines", async () => {
    const r = await runRuleCase({
      rules: [
        {
          description: "No console.log in API code.",
          severity: "warning",
          check: { type: "regex", files: ["src/**"], pattern: "console\\.log\\(" },
        },
        {
          description: "Domain modules declare their bounded context.",
          check: { type: "required-header", files: ["src/domain/**"], header: "^// context: \\w+" },
        },
      ],
      files: {
        "src/a.ts": "const a = 1;\nconsole.log(a);\nconsole.log(2);\n",
        "src/domain/billing.ts": "// context: billing\nexport const x = 1;\n",
        "src/domain/raw.ts": "export const y = 1;\n",
      },
    });
    expect(r.hits).toEqual([
      "ADR-0099 src/a.ts:2",
      "ADR-0099 src/a.ts:3",
      "ADR-0099 src/domain/raw.ts:1",
    ]);
    expect(r.violations.filter((v) => v.severity === "warning")).toHaveLength(2);
    expect(r.ok).toBe(false);
  });

  test("warnings alone do not fail the check", async () => {
    const r = await runRuleCase({
      rules: [
        {
          description: "No TODOs.",
          severity: "warning",
          check: { type: "regex", pattern: "TODO" },
        },
      ],
      files: { "a.ts": "// TODO\n" },
    });
    expect(r.ok).toBe(true);
    expect(r.hits).toHaveLength(1);
  });
});

describe("ADR parsing", () => {
  test("title, status, rule lines; legacy stubs are reported as unenforced", async () => {
    const md = adrMarkdown("0008", "Server state management", [
      { engine: "ast-grep", description: "No fetch() inside components.", pattern: "fetch($$$)" },
    ]);
    const adr = parseAdr("docs/adr/0008-server-state.md", md);
    expect(adr).toMatchObject({
      ref: "ADR-0008",
      nodeId: "adr:0008",
      title: "Server state management",
      status: "accepted",
    });
    expect(adr?.rules[0]?.line).toBe(8);

    const r = await runRuleCase({
      rules: [{ description: "legacy", pattern: "fetch($$$)" }],
      files: { "a.ts": "fetch(1)" },
    });
    expect(r.unenforced).toHaveLength(1);
    expect(r.ok).toBe(true);
  });

  test("malformed blocks are invalid and fail the check", async () => {
    const adr = parseAdr(
      "docs/adr/0003-x.md",
      '# 3. X\n\n```matrix-rules\n[{ not json\n```\n\n```matrix-rules\n[{"check":{"type":"nope"}}]\n```\n',
    );
    expect([...new Set(adr?.issues.map((i) => i.line))]).toEqual([4, 8]);
    expect(adr?.issues[0]?.message).toMatch(/invalid JSON/);
  });

  test("superseded ADRs no longer bind code", async () => {
    const md = adrMarkdown("0005", "Old", [
      { description: "x", check: { type: "regex", pattern: "x" } },
    ]).replace("accepted", "superseded by ADR-0009");
    const adr = parseAdr("docs/adr/0005-old.md", md);
    expect(adr?.status).toBe("superseded by ADR-0009");
  });
});

describe("reporting", () => {
  test("human report names ADR and file:line; receipt is adr-check", async () => {
    const r = await runRuleCase({
      adr: "0023",
      rules: [
        {
          description: "Only src/db may import drizzle-orm.",
          check: { type: "forbidden-import", import: "^drizzle-orm", except: ["src/db/**"] },
        },
      ],
      files: { "src/router.ts": 'import "drizzle-orm";\n' },
    });
    const human = formatHuman(r);
    expect(human).toContain("ADR-0023 Case (docs/adr/0023-case.md)");
    expect(human).toContain("src/router.ts:1");
    expect(human).toMatch(/^failed: 1\/1 ADR rules enforced on 1 files, 1 error/m);
    const receipt = toReceipt(r);
    expect(receipt.kind).toBe("adr-check");
    expect(receipt.ok).toBe(false);
  });
});
