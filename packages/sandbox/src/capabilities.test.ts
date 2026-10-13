import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { requiredStackTools, validateImageCapabilities } from "./capabilities.js";
import type { PodmanSandbox } from "./podman.js";
import type { ProcessSpec } from "./process.js";

describe("runner stack capabilities", () => {
  test("declares Bun for generated Node, plus optional Go/sqlc/Rust tools", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "matrix-capabilities-"));
    for (const file of ["package.json", "go.mod", "sqlc.yaml", "Cargo.toml"])
      await writeFile(join(workdir, file), "{}");
    expect(await requiredStackTools(workdir, ["codex"])).toEqual([
      "bun",
      "cargo",
      "codex",
      "git",
      "go",
      "node",
      "rustc",
      "sqlc",
    ]);
    await mkdir(join(workdir, ".matrix"));
    await writeFile(
      join(workdir, ".matrix/answers.json"),
      JSON.stringify({ "backend.orm": "sqlc" }),
    );
    expect(await requiredStackTools(workdir)).toContain("sqlc");
  });

  test("missing selected tools fail closed in a read-only network-none preflight", async () => {
    let command: ProcessSpec | undefined;
    const sandbox: Pick<PodmanSandbox, "lineExecutor"> = {
      lineExecutor: (policy) => async (spec, emit) => {
        expect(policy.network).toBe("none");
        command = spec;
        emit("Missing required stack tool: sqlc");
        return { exitCode: 127, cancelled: false, timedOut: false, stderrTail: "" };
      },
    };
    await expect(
      validateImageCapabilities(sandbox, "/work", ["go", "sqlc"], new AbortController().signal),
    ).rejects.toThrow("Missing required stack tool: sqlc");
    expect(command?.readOnly).toBe(true);
    expect(command?.env).toEqual({});
    expect(command?.cmd.slice(-2)).toEqual(["go", "sqlc"]);
  });
});
