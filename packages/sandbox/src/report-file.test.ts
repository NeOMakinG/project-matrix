import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CredentialBroker } from "./broker";
import { BwrapSandbox } from "./bwrap";
import { asRunToken } from "./launch";
import { effectiveResources, PodmanSandbox } from "./podman";
import type { LineExecutor } from "./process";
import { readReport, reportDir } from "./report-file";

const broker = new CredentialBroker({
  gatewayUrl: "http://127.0.0.1:9",
  gatewayKey: { value: "k".repeat(20) },
});

describe("report files from the sandbox", () => {
  test("reads a regular file, capped; the dir is fresh and 0700", async () => {
    const { dir, cleanup } = await reportDir("report-x.json");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    writeFileSync(join(dir, "report-x.json"), "[1]");
    expect(await readReport(dir, "report-x.json", 10)).toEqual({ text: "[1]" });
    expect(await readReport(dir, "report-x.json", 2)).toEqual({ error: "report exceeds 2 bytes" });
    expect(await readReport(dir, "missing.json", 10)).toEqual({ error: "no report written" });
    await cleanup();
    expect(existsSync(dir)).toBe(false);
  });

  test("symlinks, hardlinks, FIFOs, directories and traversal names are refused", async () => {
    const { dir, cleanup } = await reportDir("r.json");
    const secret = join(tmpdir(), `matrix-secret-${process.pid}`);
    writeFileSync(secret, "host secret");
    symlinkSync(secret, join(dir, "link.json"));
    expect(await readReport(dir, "link.json", 100)).toEqual({ error: "report is a symlink" });
    writeFileSync(join(dir, "a.json"), "x");
    linkSync(join(dir, "a.json"), join(dir, "b.json"));
    expect(await readReport(dir, "b.json", 100)).toEqual({ error: "report is not a regular file" });
    mkdirSync(join(dir, "d.json"));
    expect((await readReport(dir, "d.json", 100)) as { error: string }).toHaveProperty("error");
    execFileSync("mkfifo", [join(dir, "f.json")]);
    expect(await readReport(dir, "f.json", 100)).toEqual({ error: "report is not a regular file" });
    for (const bad of ["../x", "..", "a/b", ""])
      expect(await readReport(dir, bad, 100)).toEqual({ error: "invalid report file name" });
    await expect(reportDir("../x")).rejects.toThrow(/invalid/);
    await cleanup();
  });

  test("podman mounts the report dir rw and hands the file back after the run", async () => {
    const calls: string[][] = [];
    const executor: LineExecutor = async (s) => {
      calls.push(s.cmd);
      const mount = s.cmd.find((a) => a.endsWith(":/matrix-report:rw"));
      if (mount) writeFileSync(join(mount.slice(9, -18), "report-t.json"), '{"ok":1}');
      return { exitCode: 1, timedOut: false, cancelled: false, stderrTail: "" };
    };
    const sandbox = new PodmanSandbox({ broker, image: "img", executor });
    const result = await sandbox.exec({
      workdir: "/host/wt",
      cmd: ["eslint"],
      network: "none",
      timeoutMs: 1000,
      report: { name: "report-t.json", maxBytes: 1024 },
    });
    expect(result.report).toEqual({ text: '{"ok":1}' });
    const mount = calls[0]?.find((a) => a.endsWith(":/matrix-report:rw")) as string;
    expect(existsSync(mount.slice(9, -18))).toBe(false);
  });
});

describe("sandbox resources", () => {
  const defaults = { memory: "4g", cpus: 2, pids: 512, tmpSize: "2g" };

  test("requests override defaults, clamped to the host ceiling; bad values ignored", () => {
    expect(effectiveResources(defaults, undefined)).toEqual(defaults);
    expect(effectiveResources(defaults, { cpus: 8, memoryGb: 16 })).toMatchObject({
      cpus: 8,
      memory: "16g",
    });
    expect(
      effectiveResources(defaults, { cpus: 64, memoryGb: 400 }, { cpus: 16, memoryGb: 60 }),
    ).toMatchObject({ cpus: 16, memory: "60g" });
    expect(effectiveResources(defaults, { cpus: -1, memoryGb: Number.NaN })).toEqual(defaults);
  });

  test("podman argv carries per-spec and per-run (policy) resources", async () => {
    const sandbox = new PodmanSandbox({ broker, image: "img", maxResources: { cpus: 12 } });
    const argv = sandbox.argv(
      { cmd: ["x"], cwd: "/w", env: {}, timeoutMs: 1, resources: { cpus: 20, memoryGb: 16 } },
      { network: "none" },
      "/tmp/env",
      "r1",
    );
    expect(argv).toContain("--cpus=12");
    expect(argv).toContain("--memory=16g");
    const calls: string[][] = [];
    const executor: LineExecutor = async (s) => {
      calls.push(s.cmd);
      return { exitCode: 0, timedOut: false, cancelled: false, stderrTail: "" };
    };
    const run = new PodmanSandbox({ broker, image: "img", executor }).lineExecutor({
      runId: "r2",
      network: "none",
      resources: { cpus: 6 },
    });
    await run(
      { cmd: ["x"], cwd: "/w", env: {}, timeoutMs: 1 },
      () => {},
      new AbortController().signal,
    );
    expect(calls[0]).toContain("--cpus=6");
    expect(calls[0]).toContain("--memory=4g");
  });

  test("bwrap binds the report dir", () => {
    const argv = new BwrapSandbox({ broker }).argv(
      { cmd: ["x"], cwd: "/w", env: {}, timeoutMs: 1, reportDir: "/tmp/matrix-report-a" },
      { network: "none", token: asRunToken(`mxr_${"t".repeat(32)}`) },
    );
    expect(argv.join(" ")).toContain("--bind /tmp/matrix-report-a /matrix-report");
  });
});
