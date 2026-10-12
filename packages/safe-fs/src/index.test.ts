import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  appendFileSafe,
  ensureDir,
  isInsideReal,
  readFileSafe,
  safeJoin,
  UnsafePathError,
  writeFileSafe,
} from "./index.js";

async function dirs() {
  const repo = await mkdtemp(join(tmpdir(), "safefs-repo-"));
  const outside = await mkdtemp(join(tmpdir(), "safefs-victim-"));
  const victim = join(outside, "victim.txt");
  await writeFile(victim, "original");
  return { repo, outside, victim };
}

describe("writeFileSafe", () => {
  test("a pre-created <name>.tmp symlink cannot redirect the write (reproduced payload)", async () => {
    const { repo, victim } = await dirs();
    const target = join(repo, ".matrix", "lessons", "prompt-patch-0123456789ab.json");
    await mkdir(join(repo, ".matrix", "lessons"), { recursive: true });
    await symlink(victim, `${target}.tmp`);
    await writeFileSafe(repo, target, '{"ok":true}\n');
    expect(await readFile(victim, "utf8")).toBe("original");
    expect(await readFile(target, "utf8")).toBe('{"ok":true}\n');
  });

  test("a symlinked target or parent directory is refused", async () => {
    const { repo, outside, victim } = await dirs();
    await symlink(victim, join(repo, "out.json"));
    await expect(writeFileSafe(repo, join(repo, "out.json"), "x")).rejects.toBeInstanceOf(
      UnsafePathError,
    );
    await mkdir(join(repo, ".matrix"));
    await symlink(outside, join(repo, ".matrix", "watch"));
    await expect(
      writeFileSafe(repo, join(repo, ".matrix", "watch", "digest.md"), "x"),
    ).rejects.toBeInstanceOf(UnsafePathError);
    expect(await readdir(outside)).toEqual(["victim.txt"]);
    expect(await readFile(victim, "utf8")).toBe("original");
  });

  test("leaves no temp files behind", async () => {
    const { repo } = await dirs();
    await writeFileSafe(repo, join(repo, "a", "b.json"), "1");
    await writeFileSafe(repo, join(repo, "a", "b.json"), "2");
    expect(await readdir(join(repo, "a"))).toEqual(["b.json"]);
  });
});

describe("other helpers", () => {
  test("appendFileSafe and readFileSafe refuse symlinks", async () => {
    const { repo, victim } = await dirs();
    await symlink(victim, join(repo, "log.md"));
    await expect(appendFileSafe(repo, join(repo, "log.md"), "x")).rejects.toThrow();
    await expect(readFileSafe(repo, join(repo, "log.md"))).rejects.toBeInstanceOf(UnsafePathError);
    expect(await readFile(victim, "utf8")).toBe("original");
    expect(await readFileSafe(repo, join(repo, "missing.md"))).toBeNull();
  });

  test("ensureDir refuses a symlinked component", async () => {
    const { repo, outside } = await dirs();
    await symlink(outside, join(repo, "link"));
    await expect(ensureDir(repo, join(repo, "link", "sub"))).rejects.toBeInstanceOf(
      UnsafePathError,
    );
  });

  test("safeJoin rejects traversal; isInsideReal resolves symlinked ancestors", async () => {
    const { repo, outside } = await dirs();
    expect(() => safeJoin(repo, "../x")).toThrow(UnsafePathError);
    expect(() => safeJoin(repo, "/etc/passwd")).toThrow(UnsafePathError);
    await symlink(repo, join(outside, "repo-link"));
    expect(await isInsideReal(repo, join(outside, "repo-link", "ledger"))).toBe(true);
    expect(await isInsideReal(repo, join(outside, "elsewhere"))).toBe(false);
  });
});
