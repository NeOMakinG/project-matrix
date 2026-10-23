import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunRequest } from "@matrix/core";
import { asRunToken } from "@matrix/sandbox";
import { afterEach, describe, expect, test } from "vitest";
import { claudeCodeRunner, codexRunner } from "./index";

const gateway = {
  anthropicBaseUrl: "http://127.0.0.1:18080",
  openaiBaseUrl: "http://127.0.0.1:18080/v1",
  apiKey: asRunToken("mxr_test123"),
};

const resultLine = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Done",
  usage: { input_tokens: 1, output_tokens: 2 },
});
const toolLine = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "t1", name: "ScheduleWakeup", input: {} }] },
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A fake CLI: drains stdin, prints `lines` (a "WAIT:<ms>" entry pauses), then `tail`. */
async function fakeCli(lines: string[], tail: "exit" | "hang" | "hang-ignoring-term") {
  const dir = await mkdtemp(join(tmpdir(), "matrix-fake-cli-"));
  dirs.push(dir);
  const bin = join(dir, "fake-cli");
  const script = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", async () => {
  for (const line of ${JSON.stringify(lines)}) {
    if (line.startsWith("WAIT:")) await new Promise((r) => setTimeout(r, Number(line.slice(5))));
    else process.stdout.write(line + "\\n");
  }
  const tail = ${JSON.stringify(tail)};
  if (tail === "exit") process.exit(0);
  if (tail === "hang-ignoring-term") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
});
`;
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  return { dir, bin };
}

function request(dir: string, runner: RunRequest["runner"] = "claude-code"): RunRequest {
  return {
    runId: "r1",
    projectId: "p1",
    ticketId: "t1",
    phase: "implement",
    runner,
    model: "m",
    prompt: "go",
    workdir: dir,
    timeoutMs: 60_000,
  };
}

const baseEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe("run completion and idle detection", () => {
  test("a CLI that hangs after its result event is stopped and the run is ok", async () => {
    const { dir, bin } = await fakeCli([toolLine, resultLine], "hang");
    const events: RunEvent[] = [];
    const started = Date.now();
    const result = await claudeCodeRunner({
      gateway,
      binary: bin,
      baseEnv,
      completionGraceMs: 200,
    }).run(request(dir), (e) => events.push(e), new AbortController().signal);
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("Done");
    expect(result.tokens).toEqual({ input: 1, output: 2 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(events.at(-1)?.data).toMatchObject({ stopReason: "completed" });
  });

  test("a CLI that exits on its own after its result is not stopped", async () => {
    const { dir, bin } = await fakeCli([resultLine], "exit");
    const events: RunEvent[] = [];
    const result = await claudeCodeRunner({ gateway, binary: bin, baseEnv }).run(
      request(dir),
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(result.status).toBe("ok");
    expect(events.at(-1)?.data).toEqual({ exitCode: 0 });
  });

  test("a CLI that hangs with no result fails fast as runner idle", async () => {
    const { dir, bin } = await fakeCli([toolLine], "hang");
    const result = await claudeCodeRunner({
      gateway,
      binary: bin,
      baseEnv,
      idleTimeoutMs: 300,
    }).run(request(dir), () => {}, new AbortController().signal);
    expect(result.status).toBe("failed");
    expect(result.summary.split("\n")[0]).toBe(
      "run interrupted: claude-code runner idle: no output for 300 ms",
    );
    expect(result.summary).not.toMatch(/timed out|SIGTERM/);
  });

  test("a CLI ignoring SIGTERM after its result is killed and the run is ok", async () => {
    const { dir, bin } = await fakeCli([resultLine], "hang-ignoring-term");
    const result = await claudeCodeRunner({
      gateway,
      binary: bin,
      baseEnv,
      completionGraceMs: 100,
    }).run(request(dir), () => {}, new AbortController().signal);
    expect(result.status).toBe("ok");
  }, 15_000);

  test("steady output keeps resetting the idle timer", async () => {
    const steady = Array.from({ length: 5 }, () => ["WAIT:300", toolLine]).flat();
    // 1.5 s of total activity against a 1 s idle limit (the first line covers node startup).
    const { dir, bin } = await fakeCli([toolLine, ...steady, resultLine], "exit");
    const result = await claudeCodeRunner({
      gateway,
      binary: bin,
      baseEnv,
      idleTimeoutMs: 1000,
    }).run(request(dir), () => {}, new AbortController().signal);
    expect(result.status).toBe("ok");
  });

  test("a caller abort after the result event keeps the finished run", async () => {
    const { dir, bin } = await fakeCli([resultLine], "hang");
    const controller = new AbortController();
    const result = await claudeCodeRunner({ gateway, binary: bin, baseEnv }).run(
      request(dir),
      (e) => {
        if (e.kind === "cost") setTimeout(() => controller.abort(), 50);
      },
      controller.signal,
    );
    expect(result.status).toBe("ok");
  });

  test("a caller abort is still a cancellation", async () => {
    const { dir, bin } = await fakeCli([toolLine], "hang");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await claudeCodeRunner({ gateway, binary: bin, baseEnv }).run(
      request(dir),
      () => {},
      controller.signal,
    );
    expect(result.status).toBe("cancelled");
  });

  test("codex: a CLI that hangs after turn.completed is stopped and the run is ok", async () => {
    const { dir, bin } = await fakeCli(
      [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
      ],
      "hang",
    );
    const result = await codexRunner({
      gateway,
      binary: bin,
      baseEnv,
      completionGraceMs: 200,
    }).run(request(dir, "codex"), () => {}, new AbortController().signal);
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("ok");
  });

  test("codex: a CLI that hangs after turn.failed is stopped and the run fails", async () => {
    const { dir, bin } = await fakeCli(
      [JSON.stringify({ type: "turn.failed", error: { message: "model refused" } })],
      "hang",
    );
    const result = await codexRunner({
      gateway,
      binary: bin,
      baseEnv,
      completionGraceMs: 200,
    }).run(request(dir, "codex"), () => {}, new AbortController().signal);
    expect(result.status).toBe("failed");
    expect(result.summary.split("\n")[0]).toBe("model refused");
  });
});
