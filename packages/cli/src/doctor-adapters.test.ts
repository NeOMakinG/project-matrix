import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { localAdapters, OUTPUT_CAP } from "./doctor-adapters";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  connect: vi.fn(),
  realpath: vi.fn(),
  lstat: vi.fn(),
  statfs: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:net", () => ({ connect: mocks.connect }));
vi.mock("node:fs/promises", () => ({
  realpath: mocks.realpath,
  lstat: mocks.lstat,
  statfs: mocks.statfs,
}));

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  mocks.spawn.mockReturnValue(child);
  vi.stubEnv("PATH", "/project/node_modules/.bin:.:/trusted/bin");
  vi.stubEnv("MATRIX_ADMIN_KEY", "fixture-admin-secret");
  vi.spyOn(process, "cwd").mockReturnValue("/project/packages/sub");
  mocks.realpath.mockImplementation(async (path: string) => {
    if (path === "/usr/bin" || path === "/bin" || path === process.execPath)
      throw new Error("absent");
    return path;
  });
  mocks.lstat.mockImplementation(async (path: string) => {
    if (path === "/project/package.json") return {};
    if (path === "/trusted/bin") return { isDirectory: () => true, mode: 0o755 };
    if (path.startsWith("/trusted/bin/")) return { isFile: () => true, mode: 0o755 };
    throw new Error("absent");
  });
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test("process adapter uses only explicitly approved tools even from a nested cwd", async () => {
  const child = processFixture();
  const pending = localAdapters(["/trusted/bin"]).command(
    "git",
    ["--version"],
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  child.stdout.write("git version 2.40.0");
  child.emit("close", 0);
  expect(await pending).toBe("git version 2.40.0");
  const [binary, args, options] = mocks.spawn.mock.calls[0] ?? [];
  expect(binary).toBe("/trusted/bin/git");
  expect(args).toEqual(["--version"]);
  expect(options.shell).toBe(false);
  expect(options.stdio[0]).toBe("ignore");
  expect(options.cwd).not.toMatch(/project/);
  expect(options.env.PATH).toBe("/trusted/bin");
  expect(options.env.MATRIX_ADMIN_KEY).toBeUndefined();
});

test("default system policy ignores fake PATH binaries and restricts child PATH", async () => {
  const child = processFixture();
  vi.stubEnv("PATH", "/tmp/matrix-tools:/project/tools");
  const originalPath = mocks.realpath.getMockImplementation();
  const originalEntry = mocks.lstat.getMockImplementation();
  mocks.realpath.mockImplementation(async (path: string) =>
    path === "/usr/bin" ? path : originalPath?.(path),
  );
  mocks.lstat.mockImplementation(async (path: string) => {
    if (path === "/usr/bin") return { isDirectory: () => true, mode: 0o755 };
    if (path === "/usr/bin/git") return { isFile: () => true, mode: 0o755 };
    return originalEntry?.(path);
  });
  const pending = localAdapters().command("git", ["--version"], new AbortController().signal);
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  child.stdout.write("git version 2.40.0");
  child.emit("close", 0);
  await pending;
  const [binary, , options] = mocks.spawn.mock.calls[0] ?? [];
  expect(binary).toBe("/usr/bin/git");
  expect(options.env.PATH).toBe("/usr/bin");
});

test("process adapter kills oversized stdout/stderr without returning secret output", async () => {
  const child = processFixture();
  const pending = localAdapters(["/trusted/bin"]).command(
    "gitleaks",
    ["version"],
    new AbortController().signal,
  );
  const rejected = expect(pending).rejects.toThrow("output limit");
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  child.stderr.write("x".repeat(OUTPUT_CAP + 1));
  await rejected;
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

test("process adapter force-kills on deadline abort", async () => {
  const child = processFixture();
  const controller = new AbortController();
  const pending = localAdapters(["/trusted/bin"]).command("podman", ["info"], controller.signal);
  const rejected = expect(pending).rejects.toThrow("tool check failed");
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  controller.abort();
  child.emit("close", null);
  await rejected;
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

test.each(["bun", "podman"])(
  "never executes fake %s from inherited /tmp/matrix-tools",
  async (name) => {
    processFixture();
    vi.stubEnv("PATH", "/tmp/matrix-tools");
    mocks.lstat.mockImplementation(async (path: string) => {
      if (path === "/project/package.json") return {};
      if (path === "/tmp/matrix-tools") return { isDirectory: () => true, mode: 0o755 };
      if (path === `/tmp/matrix-tools/${name}`) return { isFile: () => true, mode: 0o755 };
      throw new Error("absent");
    });
    await expect(
      localAdapters().command(name, ["--version"], new AbortController().signal),
    ).rejects.toThrow("tool unavailable");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.realpath).not.toHaveBeenCalledWith(`/tmp/matrix-tools/${name}`);
  },
);

test.each(["bun", "podman"])(
  "never executes %s through a project symlink to /tmp/matrix-tools",
  async (name) => {
    processFixture();
    vi.stubEnv("PATH", "/project/tools");
    const original = mocks.realpath.getMockImplementation();
    mocks.realpath.mockImplementation(async (path: string) =>
      path.startsWith("/project/tools")
        ? path.replace("/project/tools", "/tmp/matrix-tools")
        : original?.(path),
    );
    const originalEntry = mocks.lstat.getMockImplementation();
    mocks.lstat.mockImplementation(async (path: string) => {
      if (path === "/project/tools") return { isSymbolicLink: () => true, mode: 0o777 };
      if (path === "/tmp/matrix-tools") return { isDirectory: () => true, mode: 0o755 };
      if (path === `/tmp/matrix-tools/${name}`) return { isFile: () => true, mode: 0o755 };
      return originalEntry?.(path);
    });
    await expect(
      localAdapters().command(name, ["--version"], new AbortController().signal),
    ).rejects.toThrow("tool unavailable");
    await expect(
      localAdapters(["/project/tools"]).command(name, ["--version"], new AbortController().signal),
    ).rejects.toThrow("tool unavailable");
    expect(mocks.spawn).not.toHaveBeenCalled();
  },
);

test("rejects an approved entry directory whose realpath is an unapproved directory", async () => {
  processFixture();
  const original = mocks.realpath.getMockImplementation();
  mocks.realpath.mockImplementation(async (path: string) =>
    path === "/trusted/bin" ? "/tmp/matrix-tools" : original?.(path),
  );
  await expect(
    localAdapters(["/trusted/bin"]).command("podman", ["info"], new AbortController().signal),
  ).rejects.toThrow("tool unavailable");
  expect(mocks.spawn).not.toHaveBeenCalled();
});

test("rejects a binary symlink even when it resolves outside the project", async () => {
  processFixture();
  const original = mocks.realpath.getMockImplementation();
  mocks.realpath.mockImplementation(async (path: string) =>
    path === "/trusted/bin/podman" ? "/tmp/matrix-tools/podman" : original?.(path),
  );
  await expect(
    localAdapters(["/trusted/bin"]).command("podman", ["info"], new AbortController().signal),
  ).rejects.toThrow("tool unavailable");
  expect(mocks.spawn).not.toHaveBeenCalled();
});

test("rejects a binary symlink with a project-controlled intermediate target", async () => {
  processFixture();
  const original = mocks.lstat.getMockImplementation();
  mocks.lstat.mockImplementation(async (path: string) =>
    path === "/trusted/bin/podman"
      ? { isFile: () => false, isSymbolicLink: () => true, mode: 0o777 }
      : original?.(path),
  );
  await expect(
    localAdapters(["/trusted/bin"]).command("podman", ["info"], new AbortController().signal),
  ).rejects.toThrow("tool unavailable");
  expect(mocks.spawn).not.toHaveBeenCalled();
});

test.each(["/trusted/bin", "/trusted/bin/podman"])(
  "rejects group/world-writable tool entry %s",
  async (entry) => {
    processFixture();
    const original = mocks.lstat.getMockImplementation();
    mocks.lstat.mockImplementation(async (path: string) =>
      path === entry
        ? {
            isDirectory: () => path === "/trusted/bin",
            isFile: () => path !== "/trusted/bin",
            mode: 0o777,
          }
        : original?.(path),
    );
    await expect(
      localAdapters(["/trusted/bin"]).command("podman", ["info"], new AbortController().signal),
    ).rejects.toThrow("tool unavailable");
    expect(mocks.spawn).not.toHaveBeenCalled();
  },
);

test("never reads tool approvals from project environment", async () => {
  processFixture();
  vi.stubEnv("MATRIX_DOCTOR_TRUSTED_TOOLS_DIR", "/trusted/bin");
  await expect(
    localAdapters().command("podman", ["info"], new AbortController().signal),
  ).rejects.toThrow("tool unavailable");
  expect(mocks.spawn).not.toHaveBeenCalled();
});

test("rejects relative and noncanonical operator approvals", () => {
  expect(() => localAdapters(["tools"])).toThrow("invalid trusted tools directory");
  expect(() => localAdapters(["/project/../trusted/bin"])).toThrow(
    "invalid trusted tools directory",
  );
  expect(mocks.spawn).not.toHaveBeenCalled();
});

test.each(["S", "N"])("Postgres adapter sends only SSLRequest, accepts %s", async (reply) => {
  const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
  mocks.connect.mockReturnValue(socket);
  const signal = new AbortController().signal;
  const pending = localAdapters().postgres("localhost", 5432, signal);
  socket.emit("connect");
  expect(socket.write).toHaveBeenCalledWith(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
  socket.emit("data", Buffer.from(reply));
  await pending;
  expect(socket.destroy).toHaveBeenCalled();
  expect(mocks.connect).toHaveBeenCalledWith({ host: "localhost", port: 5432, signal });
});

test("Postgres adapter rejects a non-Postgres service", async () => {
  const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
  mocks.connect.mockReturnValue(socket);
  const pending = localAdapters().postgres("localhost", 5432, new AbortController().signal);
  socket.emit("data", Buffer.from("HTTP/1.1"));
  await expect(pending).rejects.toThrow("not PostgreSQL");
});

test("HTTP adapter uses GET, refuses redirects and confines auth to a header", async () => {
  const fetch = vi.fn(async () => new Response('{"data":[]}'));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  const url = new URL("http://127.0.0.1/v1/models");
  expect(await localAdapters().get(url, "fixture-secret", signal)).toBe('{"data":[]}');
  expect(fetch).toHaveBeenCalledWith(url, {
    signal,
    redirect: "error",
    headers: { Authorization: "Bearer fixture-secret" },
  });
});

test("HTTP adapter rejects oversized body and cancels the stream", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("x".repeat(OUTPUT_CAP + 1))),
  );
  await expect(
    localAdapters().get(
      new URL("http://localhost/healthz"),
      undefined,
      new AbortController().signal,
    ),
  ).rejects.toThrow("output limit");
});

test("HTTP adapter discards error bodies", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("fixture-secret", { status: 401 })),
  );
  await expect(
    localAdapters().get(
      new URL("http://localhost/healthz"),
      undefined,
      new AbortController().signal,
    ),
  ).rejects.toThrow("HTTP check failed");
});

test("HTTP adapter accepts a bodyless successful health response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  expect(
    await localAdapters().get(
      new URL("http://localhost/healthz"),
      undefined,
      new AbortController().signal,
    ),
  ).toBe("");
});
