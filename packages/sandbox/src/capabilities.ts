import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { PodmanSandbox } from "./podman.js";
import { readInsideRoot } from "./safe-fs.js";

export async function requiredStackTools(
  workdir: string,
  declared: string[] = [],
): Promise<string[]> {
  const tools = new Set(["git", "node", ...declared]);
  for (const [file, needed] of [
    ["package.json", ["bun", "node"]],
    ["pnpm-lock.yaml", ["pnpm"]],
    ["go.mod", ["go"]],
    ["sqlc.yaml", ["go", "sqlc"]],
    ["sqlc.yml", ["go", "sqlc"]],
    ["Cargo.toml", ["cargo", "rustc"]],
  ] as const) {
    try {
      if (!(await lstat(join(workdir, file))).isFile())
        throw new Error(`invalid stack manifest: ${file}`);
      for (const tool of needed) tools.add(tool);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    const path = join(workdir, ".matrix/answers.json");
    if (!(await lstat(path)).isFile()) throw new Error("invalid stack answers");
    const answers = JSON.parse(
      (await readInsideRoot(workdir, ".matrix/answers.json", 1024 ** 2)).toString("utf8"),
    ) as Record<string, unknown>;
    if (answers["backend.kind"] === "go-api") tools.add("go");
    if (answers["backend.orm"] === "sqlc") {
      tools.add("go");
      tools.add("sqlc");
    }
    if (answers["desktop.shell"] === "tauri") {
      tools.add("cargo");
      tools.add("rustc");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [...tools].sort();
}

export async function validateImageCapabilities(
  sandbox: Pick<PodmanSandbox, "lineExecutor">,
  workdir: string,
  tools: string[],
  signal: AbortSignal,
): Promise<void> {
  if (!tools.length || tools.some((tool) => !/^[a-z][a-z0-9_-]*$/.test(tool)))
    throw new Error("explicit valid stack tools required");
  const output: string[] = [];
  const result = await sandbox.lineExecutor({
    runId: `preflight-${crypto.randomUUID()}`,
    network: "none",
  })(
    {
      cmd: [
        "sh",
        "-eu",
        "-c",
        'for tool do command -v "$tool" >/dev/null || { echo "Missing required stack tool: $tool"; exit 127; }; case "$tool" in go|sqlc) "$tool" version;; bun) test "$(bun --version)" = 1.3.9 || { echo "Bun 1.3.9 required"; exit 1; };; git|node|codex|cargo|rustc|python3|pnpm|yarn) "$tool" --version;; *) echo "Required executable present: $tool";; esac; done',
        "matrix-preflight",
        ...tools,
      ],
      cwd: workdir,
      env: {},
      readOnly: true,
      timeoutMs: 30_000,
    },
    (line) => output.push(line),
    signal,
  );
  if (result.exitCode !== 0 || result.timedOut || result.cancelled)
    throw new Error(
      `runner image capability preflight failed: ${output.join("\n").slice(-1000) || "required stack tools unavailable"}`,
    );
}
