import { expect, test, vi } from "vitest";
import { CredentialBroker } from "./broker.js";
import { PodmanSandbox } from "./podman.js";

test("probe exec propagates read-only mounts and suppresses oversized output, not partial secrets (mock container)", async () => {
  const broker = new CredentialBroker({
    gatewayUrl: "http://127.0.0.1:1",
    gatewayKey: { value: "fake-key-not-used" },
  });
  const sandbox = new PodmanSandbox({ image: "not-executed", broker });
  const launch = vi
    .spyOn(sandbox, "lineExecutor")
    .mockImplementation((policy) => async (spec, emit) => {
      expect(policy.network).toBe("none");
      expect(spec.readOnly).toBe(true);
      expect(spec.env).toEqual({});
      emit("safe output");
      emit("planted-secret".repeat(1000));
      return {
        exitCode: 0,
        cancelled: false,
        timedOut: false,
        stderrTail: "planted-secret".repeat(1000),
      };
    });
  try {
    const result = await sandbox.exec({
      workdir: "/unused-fixture",
      cmd: ["bun", "probe.ts"],
      network: "none",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      readOnly: true,
    });
    expect(result).toEqual({
      code: 0,
      stdout: "[output exceeded capture limit; suppressed]",
      stderr: "[stderr exceeded capture limit; suppressed]",
    });
    expect(JSON.stringify(result)).not.toContain("planted-secret");
  } finally {
    launch.mockRestore();
    await broker.closeAll();
  }
});
