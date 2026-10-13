import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CredentialBroker } from "./broker.js";
import { BwrapSandbox } from "./bwrap.js";
import { isReadOnlyExecutor } from "./executor-isolation.js";
import { asRunToken } from "./launch.js";
import { PodmanSandbox } from "./podman.js";
import { hostExecutor, type LineExecutor } from "./process.js";

test("only sandbox-produced executors advertise OS read-only enforcement", () => {
  const broker = new CredentialBroker({
    gatewayUrl: "http://127.0.0.1:9",
    gatewayKey: { value: "test-only-not-a-real-key" },
  });
  const unisolated: LineExecutor = async () => ({
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    stderrTail: "",
  });
  Object.assign(unisolated, { readOnlyIsolation: "os" });
  expect(isReadOnlyExecutor(unisolated)).toBe(false);
  expect(isReadOnlyExecutor(hostExecutor)).toBe(false);
  for (const sandbox of [
    new BwrapSandbox({ broker }),
    new PodmanSandbox({ broker, image: "matrix-test-only" }),
  ]) {
    expect(
      isReadOnlyExecutor(sandbox.lineExecutor({ runId: "readonly-test", network: "none" })),
    ).toBe(true);
    const request = { cwd: "/host/work", cmd: ["codex"], env: {}, timeoutMs: 1000, readOnly: true };
    if (sandbox instanceof BwrapSandbox) {
      const command = sandbox.argv(request, {
        network: "none",
        token: asRunToken("mxr_readonlytest"),
      });
      const mount = command.indexOf("--ro-bind");
      expect(command.slice(mount, mount + 3)).toEqual(["--ro-bind", "/host/work", "/host/work"]);
    } else {
      expect(
        sandbox.argv(request, { network: "none" }, "/tmp/test-env", "readonly-test"),
      ).toContain("--volume=/host/work:/work:ro");
    }
  }
});

test("raw host execution rejects a read-only write attack before spawning", async () => {
  const root = await mkdtemp(join(tmpdir(), "matrix-readonly-"));
  const canary = join(root, "canary");
  try {
    await writeFile(canary, "preserved");
    await expect(
      hostExecutor(
        {
          cmd: [
            process.execPath,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(canary)}, 'modified')`,
          ],
          cwd: root,
          env: {},
          timeoutMs: 1000,
          readOnly: true,
        },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("read-only OS isolation");
    expect(await readFile(canary, "utf8")).toBe("preserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
