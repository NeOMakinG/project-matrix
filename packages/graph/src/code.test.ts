import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildCodeGraph, findCycles } from "./code";
import { extractImports, resolveRelative } from "./imports";
import { checkGraphDrift, writeGraph } from "./io";
import { fixtureProject } from "./test-utils";

describe("extractImports", () => {
  test("captures every import form with its line", () => {
    const refs = extractImports(
      "a.ts",
      [
        'import { x } from "./x";',
        'import type { T } from "./t";',
        'export * from "./re";',
        'const lazy = import("./lazy");',
        'const req = require("legacy");',
        'type Q = import("./q").Q;',
      ].join("\n"),
    );
    expect(refs).toEqual([
      { specifier: "./x", line: 1, kind: "static" },
      { specifier: "./t", line: 2, kind: "type" },
      { specifier: "./re", line: 3, kind: "reexport" },
      { specifier: "./lazy", line: 4, kind: "dynamic" },
      { specifier: "legacy", line: 5, kind: "require" },
      { specifier: "./q", line: 6, kind: "type" },
    ]);
  });

  test("parses TSX", () => {
    expect(extractImports("c.tsx", 'import "./s.css";\nexport const C = () => <div />;')).toEqual([
      { specifier: "./s.css", line: 1, kind: "static" },
    ]);
  });
});

describe("resolveRelative", () => {
  const known = new Set(["src/a.ts", "src/lib/index.ts", "src/b.tsx"]);
  test("resolves extension-less, .js-for-.ts and index imports", () => {
    expect(resolveRelative("src/main.ts", "./a", known)).toBe("src/a.ts");
    expect(resolveRelative("src/main.ts", "./a.js", known)).toBe("src/a.ts");
    expect(resolveRelative("src/main.ts", "./lib", known)).toBe("src/lib/index.ts");
    expect(resolveRelative("src/x/y.ts", "../b", known)).toBe("src/b.tsx");
    expect(resolveRelative("src/main.ts", "./missing", known)).toBeUndefined();
  });
});

describe("buildCodeGraph", () => {
  test("modules, symbols, packages and runtime cycles", async () => {
    const root = await fixtureProject({
      "src/a.ts": 'import { b } from "./b";\nimport { z } from "zod";\nexport const a = () => b;\n',
      "src/b.ts": 'import { a } from "./a";\nexport function b() { return a; }\n',
      "src/types.ts": 'import type { C } from "./c";\nexport interface T { c: C }\n',
      "src/c.ts":
        'import type { T } from "./types";\nexport type C = T;\nexport default class K {}\n',
      "node_modules/zod/index.js": "export {}",
      "dist/out.js": 'import "./nope"',
    });
    const g = await buildCodeGraph(root);
    expect(g.modules.map((m) => m.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/types.ts",
    ]);
    expect(g.packages).toEqual([{ name: "zod", importers: 1 }]);
    expect(g.cycles).toEqual([["src/a.ts", "src/b.ts"]]);
    const c = g.modules.find((m) => m.path === "src/c.ts");
    expect(c?.exports).toEqual(["C", "default"]);
    expect(c?.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(["type:C", "class:K"]);
    expect(g.modules[0]?.imports[0]).toMatchObject({ specifier: "./b", target: "src/b.ts" });
  });

  test("self-loop is a cycle, independent modules are not", () => {
    const edges = new Map([
      ["a", new Set(["a"])],
      ["b", new Set(["c"])],
      ["c", new Set<string>()],
    ]);
    expect(findCycles(edges)).toEqual([["a"]]);
  });
});

describe("drift check", () => {
  test("fresh artifacts pass, a source change makes them stale", async () => {
    const root = await fixtureProject({ "src/a.ts": "export const a = 1;\n" });
    expect((await checkGraphDrift(root)).ok).toBe(false);
    await writeGraph(root);
    expect(await checkGraphDrift(root)).toEqual({ ok: true, stale: [] });
    await writeFile(join(root, "src/b.ts"), 'import { a } from "./a";\nexport const b = a;\n');
    const drift = await checkGraphDrift(root);
    expect(drift.ok).toBe(false);
    expect(drift.stale).toEqual([".matrix/graph/code.json", ".matrix/graph/GRAPH.md"]);
  });
});
