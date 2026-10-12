import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGraphDrift, featuresForTicket, loadProductGraph } from "@matrix/graph";
import { sampleAnswers } from "@matrix/packs";
import { checkProject } from "@matrix/rules";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { checkCommand } from "./check";
import { graphCommand } from "./graph";
import { runInit } from "./init";

let out = "";

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "matrix-check-"));
  const r = await runInit({
    answers: sampleAnswers,
    outDir: out,
    acceptRecommended: true,
    scaffold: true,
    date: "2026-10-12",
  });
  expect(r.status).toBe("ok");
});

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};

describe("generated project gates", () => {
  test("init writes enforced ADR rules, a fresh code graph and a CI workflow running both", async () => {
    const result = await checkProject(out);
    expect(result.ok).toBe(true);
    expect(result.stats.enforced).toBeGreaterThanOrEqual(5);
    expect(result.unenforced).toEqual([]);
    expect(await checkGraphDrift(out)).toEqual({ ok: true, stale: [] });
    const ci = await readFile(join(out, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("bin.ts check .");
    expect(ci).toContain("bin.ts graph . --check");
  });

  test("feature tickets are linked to their product features", async () => {
    const graph = await loadProductGraph(out);
    const tickets = graph.nodes.filter((n) => n.kind === "ticket");
    expect(tickets.length).toBeGreaterThan(0);
    const first = tickets[0];
    expect(first && featuresForTicket(graph, first.id)).toHaveLength(1);
  });

  test("`matrix check` exits 1 on a violation and `matrix graph --check` on drift", async () => {
    quiet();
    expect(await checkCommand([out])).toBe(0);
    await writeFile(
      join(out, "apps/api/src/leak.ts"),
      'import { eq } from "drizzle-orm";\nexport const x = eq;\n',
    );
    expect(await checkCommand([out, "--json"])).toBe(1);
    expect(await graphCommand([out, "--check"])).toBe(1);
    expect(await graphCommand([out])).toBe(0);
    expect(await graphCommand([out, "--check"])).toBe(0);
    vi.restoreAllMocks();
  });
});
