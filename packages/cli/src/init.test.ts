import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@matrix/config";
import { sampleAnswers } from "@matrix/packs";
import { describe, expect, test } from "vitest";
import { runInit, scanRepo } from "./init";

const fresh = () => mkdtemp(join(tmpdir(), "matrix-init-"));

describe("matrix init (non-interactive)", () => {
  test("golden: sample business produces config, ADRs, context, graph, backlog and scaffold", async () => {
    const out = await fresh();
    const r = await runInit({
      answers: sampleAnswers,
      outDir: out,
      acceptRecommended: true,
      scaffold: true,
      date: "2026-10-12",
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    for (const f of [
      "matrix.config.ts",
      "CONTEXT.md",
      ".matrix/graph/product.json",
      "docs/adr/0001-record-architecture-decisions.md",
      "apps/web/src/main.tsx",
      "apps/api/src/index.ts",
      "apps/api/src/trpc.ts",
      "biome.json",
    ]) {
      expect(r.files).toContain(f);
    }
    expect(r.files.filter((f) => f.startsWith("docs/adr/")).length).toBeGreaterThan(30);
    // ADR numbers follow pack order; look the decision up by topic.
    const serverState = r.files.find((f) =>
      /^docs\/adr\/\d{4}-server-state-management\.md$/.test(f),
    );
    expect(serverState).toBeDefined();
    // Stack skills are installed for agents and listed in the config.
    for (const s of ["react", "node-api", "matrix-loop", "security"])
      expect(r.files).toContain(`.claude/skills/${s}/SKILL.md`);
    expect(parseConfig(r.config).agents.skills).toContain("react");
    expect(r.tickets).toHaveLength(7);

    const answers = JSON.parse(await readFile(join(out, ".matrix/answers.json"), "utf8"));
    expect(answers["frontend.data"]).toBe("tanstack-query");
    expect(parseConfig(r.config).business.name).toBe("Ledgerly");

    const adr = await readFile(join(out, serverState ?? ""), "utf8");
    expect(adr).toContain("Use TanStack Query for server state management");
    expect(adr).toContain("```matrix-rules");

    const graph = JSON.parse(await readFile(join(out, ".matrix/graph/product.json"), "utf8"));
    expect(graph.nodes.some((n: { kind: string }) => n.kind === "persona")).toBe(true);
  });

  test("missing answers are reported instead of guessed", async () => {
    const r = await runInit({
      answers: {},
      outDir: await fresh(),
      acceptRecommended: false,
      scaffold: false,
    });
    expect(r.status).toBe("missing");
  });

  test("contradictions stop generation", async () => {
    const r = await runInit({
      answers: {
        ...sampleAnswers,
        "process.autonomy.merge": "human",
        "process.autonomy.deploy": "autonomous",
      },
      outDir: await fresh(),
      acceptRecommended: true,
      scaffold: false,
    });
    expect(r.status).toBe("contradictions");
  });

  test("--existing infers answers from a repo", async () => {
    const out = await fresh();
    await runInit({ answers: sampleAnswers, outDir: out, acceptRecommended: true, scaffold: true });
    const ctx = await scanRepo(out);
    expect(ctx.dependencies.has("@tanstack/react-query")).toBe(true);
    expect(ctx.dependencies.has("hono")).toBe(true);
  });
});

// Slow end-to-end check: installs and typechecks the generated scaffold. Run with MATRIX_E2E=1.
test.runIf(process.env.MATRIX_E2E === "1")(
  "generated scaffold installs, typechecks and lints",
  async () => {
    const out = await fresh();
    await runInit({ answers: sampleAnswers, outDir: out, acceptRecommended: true, scaffold: true });
    for (const cmd of [["install"], ["run", "typecheck"], ["run", "lint"]]) {
      const r = spawnSync("bun", cmd, { cwd: out, encoding: "utf8" });
      expect(r.status, `${cmd.join(" ")}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  },
  600_000,
);
