import { expect, test } from "vitest";
import { classifyBaseGraph, classifyChangedSource } from "./safe-git.js";

test("trusted base graph identifies frontend dependencies, backend proof and uncertainty", () => {
  const files = ["src/App.tsx", "src/theme.ts", "src/server.ts", "src/api.ts", "src/mystery.ts"];
  const graph = {
    version: 1,
    modules: [
      { path: "src/App.tsx", imports: [{ target: "src/theme.ts" }] },
      { path: "src/theme.ts", imports: [] },
      { path: "src/server.ts", imports: [{ target: "src/api.ts" }] },
      { path: "src/api.ts", imports: [] },
      { path: "src/mystery.ts", imports: [] },
    ],
  };
  expect(classifyBaseGraph(graph, files, ["src/server.ts"])).toEqual([
    { path: "src/App.tsx", role: "ui" },
    { path: "src/theme.ts", role: "ui" },
    { path: "src/server.ts", role: "server" },
    { path: "src/api.ts", role: "server" },
    { path: "src/mystery.ts", role: "unknown" },
  ]);
  const uncertainGraph = {
    ...graph,
    modules: graph.modules.map((module) =>
      module.path === "src/server.ts" ? { ...module, imports: [{ computed: true }] } : module,
    ),
  };
  expect(
    classifyBaseGraph(uncertainGraph, files, ["src/server.ts"]).find(
      (item) => item.path === "src/api.ts",
    )?.role,
  ).toBe("unknown");
  expect(() => classifyBaseGraph(graph, files, ["src/missing.ts"])).toThrow(/entrypoint missing/);
  expect(() =>
    classifyBaseGraph({ ...graph, modules: [...graph.modules, graph.modules[0]] }, files, []),
  ).toThrow(/mismatch/);
});
test("unknown external dependencies cannot prove server-only without host approval", () => {
  const graph = {
    version: 1,
    modules: [{ path: "src/server.ts", imports: [{ package: "custom-renderer" }] }],
  };
  expect(classifyBaseGraph(graph, ["src/server.ts"], ["src/server.ts"])[0]?.role).toBe("unknown");
  expect(
    classifyBaseGraph(graph, ["src/server.ts"], ["src/server.ts"], ["custom-renderer"])[0]?.role,
  ).toBe("server");
});
test("actual server-path edits cannot conceal new UI dependencies or unknown imports", () => {
  expect(
    classifyChangedSource(
      "src/api.ts",
      "import React from 'react'; React.createElement('div')",
      [],
    ),
  ).toBe("ui");
  expect(classifyChangedSource("src/api.ts", "import { render } from './new'; render();", [])).toBe(
    "unknown",
  );
  expect(classifyChangedSource("src/api.ts", "const mod = import(name);", [])).toBe("unknown");
  expect(
    classifyChangedSource("src/api.ts", "import { db } from './db'; export const total = 5;", [
      "./db",
    ]),
  ).toBe("server");
});
