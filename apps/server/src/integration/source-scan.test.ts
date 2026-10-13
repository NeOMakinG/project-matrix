import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { scanSourceSnapshot } from "./source-scan.js";

test("source handover rejects known encoded credentials without disclosing them", async () => {
  const source = await mkdtemp(join(tmpdir(), "matrix-source-canary-"));
  const canary = "matrix-unit-test-credential-not-real";
  await writeFile(join(source, "answer.ts"), Buffer.from(canary).toString("base64"));
  const receipt = await scanSourceSnapshot(source, [canary], "/nonexistent/gitleaks");
  expect(receipt.ok).toBe(false);
  expect(JSON.stringify(receipt)).not.toContain(canary);
});

test("source handover fails closed if scanner is unavailable", async () => {
  const source = await mkdtemp(join(tmpdir(), "matrix-source-unavailable-"));
  await writeFile(join(source, "answer.ts"), "export const answer = 1;");
  expect((await scanSourceSnapshot(source, [], "/nonexistent/gitleaks")).ok).toBe(false);
});

test.each(["mismatched", "missing", "extra", "duplicate"])(
  "candidate binding fails closed for %s raw objects",
  async (mode) => {
    const source = await mkdtemp(join(tmpdir(), "matrix-source-binding-"));
    const content = Buffer.from("export const answer = 1;\n");
    const sha = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    await writeFile(join(source, "answer.ts"), content);
    const objects = [
      {
        path: mode === "missing" ? "absent.ts" : "answer.ts",
        sha: mode === "mismatched" ? "0".repeat(40) : sha,
      },
    ];
    if (mode === "extra") objects.length = 0;
    if (mode === "duplicate") objects.push({ ...objects[0]! });
    expect(
      (await scanSourceSnapshot(source, [], "gitleaks", { tree: "a".repeat(40), objects })).ok,
    ).toBe(false);
  },
);
