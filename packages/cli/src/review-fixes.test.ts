import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleAnswers } from "@matrix/packs";
import { describe, expect, test } from "vitest";
import { runInit } from "./init";

const fresh = () => mkdtemp(join(tmpdir(), "matrix-fix-"));
const base = { answers: sampleAnswers, acceptRecommended: true, date: "2026-10-12" };

describe("P1-1: never overwrite or follow symlinks", () => {
  test("existing files block init without --force and stay untouched", async () => {
    const out = await fresh();
    await writeFile(join(out, "package.json"), '{"name":"mine"}');
    await writeFile(join(out, "CONTEXT.md"), "my glossary");
    const r = await runInit({ ...base, outDir: out, scaffold: true });
    expect(r.status).toBe("conflicts");
    if (r.status === "conflicts")
      expect(r.files).toEqual(expect.arrayContaining(["package.json", "CONTEXT.md"]));
    expect(await readFile(join(out, "package.json"), "utf8")).toBe('{"name":"mine"}');
    expect(await readFile(join(out, "CONTEXT.md"), "utf8")).toBe("my glossary");
  });

  test("--force replaces regular files", async () => {
    const out = await fresh();
    await writeFile(join(out, "CONTEXT.md"), "old");
    const r = await runInit({ ...base, outDir: out, scaffold: false, force: true });
    expect(r.status).toBe("ok");
    expect(await readFile(join(out, "CONTEXT.md"), "utf8")).toContain("Ledgerly");
  });

  test("symlinked files and directories are refused even with --force", async () => {
    const outside = await fresh();
    await writeFile(join(outside, "secret.txt"), "do not touch");
    const out = await fresh();
    await symlink(join(outside, "secret.txt"), join(out, "CONTEXT.md"));
    await expect(runInit({ ...base, outDir: out, scaffold: false, force: true })).rejects.toThrow(
      /symlink/,
    );
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("do not touch");

    const out2 = await fresh();
    await symlink(outside, join(out2, "docs"));
    await expect(runInit({ ...base, outDir: out2, scaffold: false, force: true })).rejects.toThrow(
      /symlink/,
    );
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });

  test("--existing only adds: user files are kept, CONTEXT.md is generated next to the user's", async () => {
    const out = await fresh();
    await writeFile(
      join(out, "package.json"),
      JSON.stringify({ dependencies: { react: "19", hono: "4" } }),
    );
    await writeFile(join(out, "CONTEXT.md"), "my glossary");
    const r = await runInit({ ...base, outDir: out, scaffold: false, existingRepo: out });
    expect(r.status).toBe("ok");
    expect(await readFile(join(out, "CONTEXT.md"), "utf8")).toBe("my glossary");
    expect(await readFile(join(out, ".matrix/CONTEXT.generated.md"), "utf8")).toContain("Ledgerly");
  });
});

describe("P1-2: ADR numbering continues after existing ADRs", () => {
  test("existing 0001 and 0002 are kept and new ADRs start at 0003 without a second record ADR", async () => {
    const out = await fresh();
    await mkdir(join(out, "docs/adr"), { recursive: true });
    await writeFile(join(out, "docs/adr/0001-use-postgres.md"), "# 1. Use Postgres");
    await writeFile(join(out, "docs/adr/0002-monorepo.md"), "# 2. Monorepo");
    const r = await runInit({ ...base, outDir: out, scaffold: false, existingRepo: out });
    expect(r.status).toBe("ok");
    const adrs = (await readdir(join(out, "docs/adr"))).sort();
    expect(adrs[0]).toBe("0001-use-postgres.md");
    expect(adrs[1]).toBe("0002-monorepo.md");
    expect(adrs[2]?.startsWith("0003-")).toBe(true);
    expect(adrs.filter((f) => f.includes("record-architecture-decisions"))).toEqual([]);
    expect(await readFile(join(out, "docs/adr/0001-use-postgres.md"), "utf8")).toBe(
      "# 1. Use Postgres",
    );
  });
});

describe("P1-3: answer strings are encoded per output context", () => {
  test("a malicious product name stays inert in JSX, HTML and markdown", async () => {
    const evil = "</h1><script>alert(1)</script>{process.exit(1)}`${x}`";
    const out = await fresh();
    const r = await runInit({
      ...base,
      answers: {
        ...sampleAnswers,
        "business.name": evil,
        "business.valueProposition": "<img src=x onerror=alert(1)>",
      },
      outDir: out,
      scaffold: true,
    });
    expect(r.status).toBe("ok");
    const main = await readFile(join(out, "apps/web/src/main.tsx"), "utf8");
    expect(main).toContain(`{${JSON.stringify(evil)}}`);
    expect(main).not.toMatch(/<h1>[^{]/);
    const html = await readFile(join(out, "apps/web/index.html"), "utf8");
    expect(html).toContain("&lt;/h1&gt;&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    const context = await readFile(join(out, "CONTEXT.md"), "utf8");
    expect(context).not.toContain("<script>");
    expect(context).toContain("\\<script\\>");
    const config = await readFile(join(out, "matrix.config.ts"), "utf8");
    expect(config).toContain(JSON.stringify(evil));
  });
});

describe("P2: Biome scope and idempotent reruns", () => {
  test("Biome formats only generated files, never unrelated user files", async () => {
    const out = await fresh();
    await mkdir(join(out, "notes"));
    await writeFile(join(out, "notes/user.ts"), "const   x=1\n");
    const r = await runInit({ ...base, outDir: out, scaffold: true });
    expect(r.status).toBe("ok");
    expect(await readFile(join(out, "notes/user.ts"), "utf8")).toBe("const   x=1\n");
  });

  test("re-running init does not duplicate the backlog", async () => {
    const out = await fresh();
    const first = await runInit({ ...base, outDir: out, scaffold: false });
    const second = await runInit({ ...base, outDir: out, scaffold: false, force: true });
    expect(first.status === "ok" && second.status === "ok").toBe(true);
    if (first.status === "ok" && second.status === "ok")
      expect(second.tickets).toEqual(first.tickets);
    const files = (await readdir(join(out, ".matrix/tickets"))).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(first.status === "ok" ? first.tickets.length : -1);
  });
});

describe("P2: re-running init keeps ADR numbers stable", () => {
  test("a forced rerun rewrites the same ADR files instead of appending duplicates", async () => {
    const out = await fresh();
    const first = await runInit({ ...base, outDir: out, scaffold: false });
    const before = (await readdir(join(out, "docs/adr"))).sort();
    const second = await runInit({ ...base, outDir: out, scaffold: false, force: true });
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect((await readdir(join(out, "docs/adr"))).sort()).toEqual(before);
  });

  test("--existing twice adds nothing new the second time", async () => {
    const out = await fresh();
    await runInit({ ...base, outDir: out, scaffold: false, existingRepo: out });
    const before = (await readdir(join(out, "docs/adr"))).length;
    const again = await runInit({ ...base, outDir: out, scaffold: false, existingRepo: out });
    expect(again.status).toBe("ok");
    expect((await readdir(join(out, "docs/adr"))).length).toBe(before);
  });
});

describe("round 2: backlog writes are confined like every other write", () => {
  test("--existing with .matrix/tickets symlinked outside refuses and writes nothing anywhere", async () => {
    const outside = await fresh();
    const out = await fresh();
    await mkdir(join(out, ".matrix"));
    await symlink(outside, join(out, ".matrix/tickets"));
    await expect(
      runInit({ ...base, outDir: out, scaffold: false, existingRepo: out }),
    ).rejects.toThrow(/symlink/);
    expect(await readdir(outside)).toEqual([]);
    expect((await readdir(out)).sort()).toEqual([".matrix"]);
    expect((await readdir(join(out, ".matrix"))).sort()).toEqual(["tickets"]);
  });

  test("a symlinked .ids directory is refused too", async () => {
    const outside = await fresh();
    const out = await fresh();
    await mkdir(join(out, ".matrix/tickets"), { recursive: true });
    await symlink(outside, join(out, ".matrix/tickets/.ids"));
    await expect(
      runInit({ ...base, outDir: out, scaffold: false, existingRepo: out }),
    ).rejects.toThrow(/symlink/);
    expect(await readdir(outside)).toEqual([]);
  });

  test("the CLI prints one clean refusal line instead of a stack trace", async () => {
    const { spawnSync } = await import("node:child_process");
    const outside = await fresh();
    const out = await fresh();
    await mkdir(join(out, ".matrix"));
    await symlink(outside, join(out, ".matrix/tickets"));
    const answers = join(await fresh(), "answers.json");
    await writeFile(answers, JSON.stringify(sampleAnswers));
    const bin = join(import.meta.dirname, "bin.ts");
    const r = spawnSync("bun", [bin, "init", out, "--existing", "--answers", answers, "--yes"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(3);
    expect(r.stderr.trim()).toMatch(/^matrix: refusing .*symlink/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(await readdir(outside)).toEqual([]);
  });
});
