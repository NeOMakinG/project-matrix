import { createResolver } from "@matrix/graph";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSourceIndex, runCheck } from "./checks";
import { goList, goParseImports } from "./golist";

vi.mock("./golist", async (importOriginal) => {
  const original = await importOriginal<typeof import("./golist")>();
  return { ...original, goList: vi.fn(), goParseImports: vi.fn() };
});

const root = "/__go_cache__";
const files = [
  "services/api/router.go",
  "services/storage/access.go",
  "services/storage/safe.go",
] as const;
let storageImport: string;

async function index() {
  const resolver = await createResolver(root, [], async () => undefined);
  return createSourceIndex([], async () => "", {
    root,
    diskRoot: root,
    resolver,
    allFiles: ["services/api/go.mod", "services/storage/go.mod", ...files],
    textFiles: [...files],
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  storageImport = "database/sql";
  vi.mocked(goList).mockImplementation((_root, moduleDir) => ({
    ok: true,
    packages: [
      {
        dir: moduleDir.slice(root.length + 1),
        files: files.filter((file) => file.startsWith(`${moduleDir.slice(root.length + 1)}/`)),
        ignoredFiles: [],
        imports: [],
      },
    ],
  }));
  vi.mocked(goParseImports).mockImplementation(
    (paths) =>
      new Map(
        paths.map((file) => [
          file,
          {
            imports: [{ path: file.endsWith("access.go") ? storageImport : "fmt", line: 3 }],
            dbCalls: file.endsWith("access.go") ? [{ method: "Exec", line: 5 }] : [],
          },
        ]),
      ),
  );
});

describe("Go import parsing is cached only within a source index", () => {
  test("each file is parsed once across rules without losing scope or attribution", async () => {
    const sources = await index();
    expect(
      await runCheck({ type: "go-imports", import: "^database/sql$", files: [files[1]] }, sources),
    ).toEqual([{ file: files[1], line: 3, message: 'imports "database/sql"' }]);
    const broad = await runCheck({ type: "go-imports", import: "^(database/sql|fmt)$" }, sources);
    expect(broad.map((hit) => hit.file)).toEqual(files);
    expect(
      await runCheck({ type: "go-imports", import: "^database/sql$", except: [files[1]] }, sources),
    ).toEqual([]);
    expect(await runCheck({ type: "go-db-calls" }, sources)).toEqual([
      {
        file: files[1],
        line: 5,
        message: "raw database method reference Exec is allowed only in verified sqlc output",
      },
    ]);
    expect(goList).toHaveBeenCalledTimes(2);
    expect(goParseImports).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(goParseImports)
        .mock.calls.flatMap(([paths]) => paths)
        .sort(),
    ).toEqual(files.map((file) => `${root}/${file}`).sort());
  });

  test("cached parser deadline errors fail every applicable rule closed", async () => {
    vi.mocked(goParseImports).mockImplementation(() => {
      throw new Error("parser deadline exceeded");
    });
    const sources = await index();
    for (const pattern of ["^database/sql$", "^not/imported$"]) {
      const hits = await runCheck({ type: "go-imports", import: pattern }, sources);
      expect(hits.map((hit) => hit.file)).toEqual(files);
      expect(
        hits.every(
          (hit) =>
            hit.message.includes("unverifiable: Error: parser deadline exceeded") && !hit.severity,
        ),
      ).toBe(true);
    }
    expect(goParseImports).toHaveBeenCalledTimes(1);
    const calls = await runCheck({ type: "go-db-calls" }, sources);
    expect(calls).toHaveLength(files.length);
    expect(calls.every((hit) => hit.message.includes("unverifiable"))).toBe(true);
    expect(goParseImports).toHaveBeenCalledTimes(1);
  });

  test("missing call AST data cannot turn an import-only result into a pass", async () => {
    vi.mocked(goParseImports).mockImplementation(
      (paths) => new Map(paths.map((file) => [file, { imports: [] }])),
    );
    const hits = await runCheck({ type: "go-db-calls" }, await index());
    expect(hits).toHaveLength(files.length);
    expect(hits.every((hit) => hit.message.includes("missing AST results"))).toBe(true);
  });

  test("a fresh index rereads imports rather than reusing an earlier clean snapshot", async () => {
    storageImport = "fmt";
    expect(await runCheck({ type: "go-imports", import: "^database/sql$" }, await index())).toEqual(
      [],
    );
    storageImport = "database/sql";
    expect(await runCheck({ type: "go-imports", import: "^database/sql$" }, await index())).toEqual(
      [{ file: files[1], line: 3, message: 'imports "database/sql"' }],
    );
    expect(goParseImports).toHaveBeenCalledTimes(2);
    expect(goList).toHaveBeenCalledTimes(4);
  });
});
