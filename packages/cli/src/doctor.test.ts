import { afterEach, expect, test, vi } from "vitest";
import { diagnose, doctorCommand } from "./doctor";
import { type DoctorAdapters, OUTPUT_CAP } from "./doctor-adapters";

function fixture(): DoctorAdapters {
  return {
    platform: "linux",
    release: "fixture",
    env: {
      MATRIX_DOCTOR_POSTGRES_URL: "postgresql://fixture:fixture-password@localhost:5432/matrix",
      MATRIX_DOCTOR_GATEWAY_URL: "http://127.0.0.1:8317",
      MATRIX_DOCTOR_GATEWAY_HEALTH_URL: "http://127.0.0.1:8317/healthz",
      MATRIX_DOCTOR_GATEWAY_TOKEN: "fixture-secret",
    },
    command: vi.fn(async (name) => {
      if (name === "bun") return "1.3.0";
      if (name === "git") return "git version 2.40.0";
      if (name === "podman") return '{"host":{"security":{"rootless":true}}}';
      if (name === "gitleaks") return "8.24.0";
      return "fixture version";
    }),
    postgres: vi.fn(async () => {}),
    get: vi.fn(async (url) =>
      url.pathname === "/v1/models" ? '{"data":[{"id":"fixture-private-model"}]}' : '{"ok":true}',
    ),
    resources: vi.fn(async () => ({ ram: 8 * 1024 ** 3, disk: 20 * 1024 ** 3 })),
  };
}

afterEach(() => vi.useRealTimers());

test("JSON reports prerequisites, never claims runtime readiness or leaks credentials", async () => {
  const adapters = fixture();
  const output: string[] = [];
  expect(await doctorCommand(["--json"], adapters, (text) => output.push(text))).toBe(0);
  const report = JSON.parse(output.join(""));
  expect(report.runtimeVerified).toBe(false);
  expect(report.publishBlocked).toBe(false);
  expect(report.checks.find((entry: { id: string }) => entry.id === "runtime").status).toBe("warn");
  expect(output.join("")).not.toMatch(/fixture-secret|fixture-password|fixture-private-model/);
  expect(adapters.postgres).toHaveBeenCalledWith("localhost", 5432, expect.any(AbortSignal));
  expect(adapters.get).toHaveBeenCalledTimes(2);
});

test.each(["2.39.9", "1.99.0", "unknown"])("rejects old/invalid Git %s", async (version) => {
  const adapters = fixture();
  const original = adapters.command;
  adapters.command = async (name, args, signal) =>
    name === "git" ? `git version ${version}` : original(name, args, signal);
  const report = await diagnose(adapters);
  expect(report.checks.find((entry) => entry.id === "git")?.status).toBe("fail");
});

test("missing gitleaks blocks publishing and errors are entirely withheld", async () => {
  const adapters = fixture();
  adapters.command = async () => {
    throw new Error("https://private:password@host Bearer arbitrary-credential");
  };
  const report = await diagnose(adapters);
  expect(report.publishBlocked).toBe(true);
  expect(report.blocked).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(/arbitrary-credential|private:password|@host/);
});

test("rootful Podman falls back to a real bwrap namespace probe", async () => {
  const adapters = fixture();
  const original = adapters.command;
  adapters.command = vi.fn(async (name, args, signal) =>
    name === "podman" ? '{"host":{"security":{"rootless":false}}}' : original(name, args, signal),
  );
  const report = await diagnose(adapters);
  expect(report.checks.find((entry) => entry.id === "sandbox")?.detail).toContain("bwrap");
  expect(adapters.command).toHaveBeenCalledWith(
    "bwrap",
    expect.arrayContaining(["--unshare-all", "/usr/bin/true"]),
    expect.any(AbortSignal),
  );
});

test.each(["darwin", "win32"])("%s is explicitly unsupported for runtime", async (platform) => {
  const adapters = fixture();
  adapters.platform = platform;
  const report = await diagnose(adapters);
  expect(report.checks.find((entry) => entry.id === "sandbox")?.status).toBe("unsupported");
  expect(report.blocked).toBe(true);
  expect(adapters.command).not.toHaveBeenCalledWith("podman", expect.anything(), expect.anything());
});

test("WSL is detected without claiming integration support", async () => {
  const adapters = fixture();
  adapters.release = "6.6.0-microsoft-standard-WSL2";
  expect((await diagnose(adapters)).checks.find((entry) => entry.id === "wsl")?.status).toBe(
    "warn",
  );
});

test.each([
  "https://paid.example.com",
  "http://user:secret@localhost",
  "http://localhost?token=secret",
  "http://localhost/v1/chat/completions",
  "http://192.0.2.1",
])("refuses nonlocal/unsafe gateway %s without network access", async (url) => {
  const adapters = fixture();
  adapters.env.MATRIX_DOCTOR_GATEWAY_URL = url;
  delete adapters.env.MATRIX_DOCTOR_GATEWAY_HEALTH_URL;
  const report = await diagnose(adapters);
  expect(report.checks.find((entry) => entry.id === "gateway-models")?.status).toBe("fail");
  expect(adapters.get).not.toHaveBeenCalled();
});

test.each(['{"data":[]}', '{"data":[{}]}', "not JSON", "x".repeat(OUTPUT_CAP + 1)])(
  "rejects invalid or oversized models response",
  async (body) => {
    const adapters = fixture();
    adapters.get = async () => body;
    expect(
      (await diagnose(adapters)).checks.find((entry) => entry.id === "gateway-models")?.status,
    ).toBe("fail");
  },
);

test("missing configuration never probes assumed endpoints", async () => {
  const adapters = fixture();
  adapters.env = {};
  const report = await diagnose(adapters);
  expect(report.blocked).toBe(true);
  expect(adapters.get).not.toHaveBeenCalled();
  expect(adapters.postgres).not.toHaveBeenCalled();
});

test("configured network failures and resource failures are redacted", async () => {
  const adapters = fixture();
  adapters.postgres = adapters.get = async () => {
    throw new Error("fixture-secret private-url");
  };
  adapters.resources = async () => ({ ram: 1, disk: 1 });
  const report = await diagnose(adapters);
  expect(report.checks.find((entry) => entry.id === "headroom")?.status).toBe("warn");
  expect(JSON.stringify(report)).not.toMatch(/fixture-secret|private-url/);
});

test("optional tools are opt-in; failures warn", async () => {
  const adapters = fixture();
  expect((await diagnose(adapters)).checks.some((entry) => entry.id === "orca")).toBe(false);
  const original = adapters.command;
  adapters.command = async (name, args, signal) => {
    if (["orca", "tailscale"].includes(name)) throw new Error("missing");
    return original(name, args, signal);
  };
  const report = await diagnose(adapters, true);
  expect(report.checks.find((entry) => entry.id === "orca")?.status).toBe("warn");
  expect(report.blocked).toBe(false);
});

test("hung adapters respect per-check and total deadlines", async () => {
  vi.useFakeTimers();
  const adapters = fixture();
  const hang = (): Promise<never> => new Promise(() => {});
  adapters.command = hang;
  adapters.get = hang;
  adapters.postgres = hang;
  const pending = diagnose(adapters, true);
  await vi.advanceTimersByTimeAsync(20_100);
  const report = await pending;
  expect(report.blocked).toBe(true);
  expect(report.publishBlocked).toBe(true);
});

test("human output and invalid-option errors do not echo inputs", async () => {
  const output: string[] = [];
  expect(await doctorCommand([], fixture(), (text) => output.push(text))).toBe(0);
  expect(output.join("")).toContain("PASS git");
  expect(await doctorCommand(["--private-secret"], fixture(), (text) => output.push(text))).toBe(2);
  expect(output.join("")).not.toContain("private-secret");
});

test("invalid JSON options return a redacted machine-readable failure", async () => {
  const output: string[] = [];
  expect(
    await doctorCommand(["--json", "--fixture-secret"], fixture(), (text) => output.push(text)),
  ).toBe(2);
  expect(JSON.parse(output[0] ?? "").blocked).toBe(true);
  expect(output.join("")).not.toContain("fixture-secret");
});
