/**
 * Integration check on a host with rootless Podman (run with `bun`):
 *   MATRIX_IT_GATEWAY_URL=http://<gateway>:8317 MATRIX_IT_KEY_FILE=~/.hermes/config.yaml \
 *   MATRIX_IT_IMAGE=matrix-runner:dev bun packages/runners/integration/podman-runner.it.ts
 *
 * Proves: a runner executes inside a container, the container only holds a run token (never the real
 * gateway key), a real model reply arrives through the broker, and the host CDP port is unreachable.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeRunner } from "@matrix/runners";
import {
  CredentialBroker,
  PodmanSandbox,
  RUN_TOKEN_PLACEHOLDER,
  resolveCredential,
} from "@matrix/sandbox";

const gatewayUrl = process.env.MATRIX_IT_GATEWAY_URL ?? "";
const keyFile = process.env.MATRIX_IT_KEY_FILE ?? "";
const image = process.env.MATRIX_IT_IMAGE ?? "matrix-runner:dev";
const model = process.env.MATRIX_IT_MODEL ?? "claude-sonnet-5-5";
if (!gatewayUrl || !keyFile) throw new Error("set MATRIX_IT_GATEWAY_URL and MATRIX_IT_KEY_FILE");

const keySource = { file: keyFile, pattern: /^\s*api_key:\s*(\S+)/m };
const realKey = await resolveCredential(keySource);
const broker = new CredentialBroker({ gatewayUrl, gatewayKey: keySource });
const sandbox = new PodmanSandbox({ broker, image, resources: { memory: "2g", cpus: 2 } });
const work = await mkdtemp(join(tmpdir(), "matrix-it-"));
await writeFile(join(work, "README.md"), "integration\n");

const results: Array<{ check: string; ok: boolean; detail: string }> = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${check}: ${detail}`);
};

// 1. Inside the container: whoami, env holds only the run token, real key absent everywhere we can see.
const probe = await sandbox.exec({
  workdir: work,
  network: "gateway",
  timeoutMs: 60_000,
  cmd: [
    "sh",
    "-c",
    'echo "uid=$(id -u) host=$(hostname)"; env | grep -c MATRIX_RUN_TOKEN; cat /proc/1/environ /proc/self/environ 2>/dev/null | tr "\\0" "\\n" > /tmp/env.txt; ls /run/matrix; ls /home 2>&1 | head -3',
  ],
});
record("container starts", probe.code === 0, probe.stdout.split("\n")[0] ?? "");
const envDump = await sandbox.exec({
  workdir: work,
  network: "gateway",
  timeoutMs: 60_000,
  cmd: ["sh", "-c", "env; cat /run/matrix/* 2>/dev/null | head -c 200 || true"],
});
const leaked = envDump.stdout.includes(realKey);
record(
  "real gateway key absent from container env",
  !leaked,
  leaked ? "LEAKED" : "only MATRIX_RUN_TOKEN present",
);

// 2. Host CDP / loopback services unreachable.
const cdp = await sandbox.exec({
  workdir: work,
  network: "gateway",
  timeoutMs: 30_000,
  cmd: [
    "sh",
    "-c",
    "curl -s -m 3 http://127.0.0.1:9223/json/version >/dev/null && echo REACHABLE || echo blocked",
  ],
});
record("host CDP 127.0.0.1:9223 unreachable", cdp.stdout.trim() === "blocked", cdp.stdout.trim());

// 3. Direct gateway bypass impossible (network none at the container level).
const bypass = await sandbox.exec({
  workdir: work,
  network: "gateway",
  timeoutMs: 30_000,
  cmd: [
    "sh",
    "-c",
    `curl -s -m 3 ${gatewayUrl}/v1/models >/dev/null && echo REACHABLE || echo blocked`,
  ],
});
record(
  "gateway not reachable except via broker socket",
  bypass.stdout.trim() === "blocked",
  bypass.stdout.trim(),
);

// 4. Real runner inside the container, real model reply through the broker.
const runId = `it-${Date.now()}`;
const runner = claudeCodeRunner({
  gateway: {
    anthropicBaseUrl: "http://127.0.0.1:18080",
    openaiBaseUrl: "http://127.0.0.1:18080/v1",
    apiKey: RUN_TOKEN_PLACEHOLDER,
  },
  executor: sandbox.lineExecutor({ runId, network: "gateway" }),
  skipPermissions: true,
  baseEnv: {},
});
const events: string[] = [];
const result = await runner.run(
  {
    runId,
    projectId: "it",
    ticketId: "IT-1",
    phase: "implement",
    runner: "claude-code",
    model,
    prompt: "Reply with exactly the word OK and nothing else.",
    workdir: work,
    timeoutMs: 240_000,
  },
  (e) => events.push(`${e.kind}: ${e.message.slice(0, 80)}`),
  new AbortController().signal,
);
record(
  "claude-code runner in container got a model reply",
  result.status === "ok" && /\bOK\b/.test(result.summary),
  `status=${result.status} summary=${JSON.stringify(result.summary.slice(0, 120))} tokens=${JSON.stringify(result.tokens)}`,
);

await broker.closeAll();
console.log(JSON.stringify({ results, events: events.slice(0, 12) }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
