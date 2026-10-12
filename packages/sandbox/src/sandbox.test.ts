import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CredentialBroker } from "./broker";
import { BwrapSandbox } from "./bwrap";
import { asRunToken, mapPath, RUN_TOKEN_PLACEHOLDER, withBridge } from "./launch";
import { PodmanSandbox } from "./podman";
import { hostExecutor, type LineExecutor, runToCompletion } from "./process";
import { runSecretGate, secretNeedles } from "./secret-gate";

const broker = new CredentialBroker({
  gatewayUrl: "http://127.0.0.1:9",
  gatewayKey: { value: "k".repeat(20) },
});
const spec = {
  cmd: ["codex", "exec", "-C", "/host/wt", "-"],
  cwd: "/host/wt",
  env: { FOO: "/host/wt/x", PATH: "/leak" },
  timeoutMs: 1000,
};

describe("podman argv", () => {
  const sandbox = new PodmanSandbox({ broker, image: "matrix-runner:dev" });

  test("locks the container down and mounts only the worktree", () => {
    const argv = sandbox.argv(spec, { network: "none" }, "/tmp/envfile", "run-1");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--network=none",
        "--cap-drop=all",
        "--read-only",
        "--security-opt=no-new-privileges",
        "--volume=/host/wt:/work:rw",
        "--env-file=/tmp/envfile",
      ]),
    );
    expect(argv.filter((a) => a.startsWith("--volume=")).length).toBe(1);
    expect(argv.slice(-5)).toEqual(["codex", "exec", "-C", "/work", "-"]);
  });

  test("gateway runs mount the socket dir and start the bridge", () => {
    const argv = sandbox.argv(
      spec,
      { network: "gateway", socketDir: "/tmp/matrix-sockets/x" },
      "/e",
      "run-2",
    );
    expect(argv).toContain("--volume=/tmp/matrix-sockets/x:/run/matrix:rw");
    expect(argv.join(" ")).toContain("/opt/matrix/bridge.mjs");
    expect(argv).toContain("--network=none");
  });

  test("container env maps paths, drops host PATH and adds the run token only for networked runs", () => {
    expect(sandbox.containerEnv(spec, "gateway", "tok")).toEqual({
      HOME: "/home/agent",
      MATRIX_LLM_URL: "http://127.0.0.1:18080",
      FOO: "/work/x",
      MATRIX_RUN_TOKEN: "tok",
    });
    expect(sandbox.containerEnv(spec, "none", "tok").MATRIX_RUN_TOKEN).toBeUndefined();
  });

  test("lineExecutor writes an env file, runs podman and cleans up", async () => {
    const calls: string[][] = [];
    const executor: LineExecutor = async (s, onLine) => {
      calls.push(s.cmd);
      onLine("hello");
      return { exitCode: 0, timedOut: false, cancelled: false, stderrTail: "" };
    };
    const local = new PodmanSandbox({ broker, image: "img", executor });
    const result = await local.exec({
      workdir: "/host/wt",
      cmd: ["true"],
      network: "none",
      timeoutMs: 1000,
    });
    expect(result).toEqual({ code: 0, stdout: "hello", stderr: "" });
    expect(calls[0]?.[1]).toBe("run");
    expect(calls[1]).toEqual(expect.arrayContaining(["rm", "-f", "--ignore"]));
  });
});

describe("bwrap argv", () => {
  test("no network, no host home, worktree writable", () => {
    const sandbox = new BwrapSandbox({ broker, readOnlyBinds: ["/opt/node"] });
    const argv = sandbox.argv(spec, { network: "none", token: asRunToken("mxr_t") });
    expect(argv).toEqual(
      expect.arrayContaining(["--unshare-all", "--clearenv", "--die-with-parent"]),
    );
    expect(argv.join(" ")).toContain("--bind /host/wt /host/wt");
    expect(argv.join(" ")).toContain("--ro-bind /opt/node /opt/node");
    expect(argv.join(" ")).not.toContain(process.env.HOME ?? "/Users");
    expect(argv.join(" ")).toContain("--setenv PATH /usr/local/bin:/usr/bin:/bin");
    expect(argv.join(" ")).not.toContain("/leak");
  });
});

test("withBridge and mapPath", () => {
  expect(withBridge(["a"], false)).toEqual(["a"]);
  expect(withBridge(["a", "b"], true).slice(-3)).toEqual(["matrix-sandbox", "a", "b"]);
  expect(mapPath("/w/a", "/w", "/work")).toBe("/work/a");
  expect(mapPath("/wx", "/w", "/work")).toBe("/wx");
});

describe("host executor", () => {
  test("streams lines, passes stdin and only the given env", async () => {
    const out = await runToCompletion(hostExecutor, {
      cmd: ["sh", "-c", 'cat; echo; echo "v=$ONLY"; echo "h=${HOME:-none}"'],
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin", ONLY: "1" },
      stdin: "in",
      timeoutMs: 5000,
    });
    expect(out.stdout.split("\n")).toEqual(["in", "v=1", "h=none"]);
    expect(out.exitCode).toBe(0);
  });

  test("times out and kills the process group", async () => {
    const out = await runToCompletion(hostExecutor, {
      cmd: ["sh", "-c", "sleep 5"],
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 200,
    });
    expect(out.timedOut).toBe(true);
  });
});

describe("secret gate", () => {
  const hasGitleaks = (() => {
    try {
      execFileSync("gitleaks", ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  async function repoWith(content: string, deleteAfter = false): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "matrix-secret-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });
    git("init", "-q");
    await writeFile(join(dir, "a.txt"), content);
    git("add", ".");
    git("commit", "-qm", "one");
    if (deleteAfter) {
      git("rm", "-q", "a.txt");
      git("commit", "-qm", "two");
    }
    return dir;
  }

  const secret = { name: "gateway", value: "sk-matrix-test-1234567890abcdef" };

  test("clean repo passes", async () => {
    const repo = await repoWith("hello");
    const result = await runSecretGate({
      gitDir: join(repo, ".git"),
      secretValues: [secret],
      skipGitleaks: !hasGitleaks,
    });
    expect(result.ok).toBe(true);
    expect(result.receipt.kind).toBe("secret-scan");
  });

  test("finds raw, base64 and hex encodings even in deleted history", async () => {
    for (const encoded of [
      secret.value,
      Buffer.from(secret.value).toString("base64"),
      Buffer.from(secret.value).toString("hex"),
    ]) {
      const repo = await repoWith(`x=${encoded}\n`, true);
      const result = await runSecretGate({
        gitDir: join(repo, ".git"),
        secretValues: [secret],
        skipGitleaks: true,
      });
      expect(result.ok).toBe(false);
      expect(result.findings[0]?.rule).toBe("value:gateway");
      expect(JSON.stringify(result)).not.toContain(secret.value);
    }
  });

  test.runIf(hasGitleaks)("gitleaks catches a planted token pattern", async () => {
    const repo = await repoWith(`token = "ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}"\n`);
    const result = await runSecretGate({ gitDir: join(repo, ".git") });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.source === "gitleaks")).toBe(true);
  });

  test("short values are ignored", () => {
    expect(secretNeedles("short")).toEqual([]);
  });
});

test("run token placeholder is replaced at launch", () => {
  const sandbox = new PodmanSandbox({ broker, image: "img" });
  const env = sandbox.containerEnv(
    { ...spec, env: { ANTHROPIC_API_KEY: RUN_TOKEN_PLACEHOLDER } },
    "gateway",
    "mxr_abc",
  );
  expect(env.ANTHROPIC_API_KEY).toBe("mxr_abc");
});

describe("secret gate hardening", () => {
  const secret = { name: "gateway", value: "sk-matrix-test-1234567890abcdef" };
  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir })
      .toString()
      .trim();

  test("repo allowlists and ignore files cannot silence gitleaks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-gl-"));
    git(dir, "init", "-q");
    const token = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
    await writeFile(join(dir, "a.txt"), `token = "${token}"\n`);
    await writeFile(join(dir, ".gitleaks.toml"), '[allowlist]\npaths = [".*"]\n');
    await writeFile(join(dir, ".gitleaksignore"), "*\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "c");
    const result = await runSecretGate({ gitDir: join(dir, ".git") });
    expect(result.findings.some((f) => f.source === "gitleaks")).toBe(true);
  });

  test("git replace objects cannot hide a secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-rp-"));
    git(dir, "init", "-q");
    await writeFile(join(dir, "a.txt"), `k=${secret.value}\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "secret");
    const dirty = git(dir, "rev-parse", "HEAD:a.txt");
    const clean = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      input: "clean\n",
    })
      .toString()
      .trim();
    git(dir, "replace", dirty, clean);
    const result = await runSecretGate({
      gitDir: join(dir, ".git"),
      secretValues: [secret],
      skipGitleaks: true,
    });
    expect(result.ok).toBe(false);
  });

  test("scans exactly the requested push range", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-range-"));
    git(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "base.txt"), "base\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    git(dir, "checkout", "-qb", "feature");
    await writeFile(join(dir, "f.txt"), `k=${secret.value}\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "feat");
    const gate = (revs: string[]) =>
      runSecretGate({
        gitDir: join(dir, ".git"),
        revs,
        secretValues: [secret],
        skipGitleaks: true,
      });
    expect((await gate(["main..feature"])).ok).toBe(false);
    expect((await gate(["main"])).ok).toBe(true);
  });
});

test("readOnly runs mount the worktree read-only in both sandboxes", () => {
  const ro = { ...spec, readOnly: true };
  const podman = new PodmanSandbox({ broker, image: "img" }).argv(
    ro,
    { network: "none" },
    "/e",
    "r",
  );
  expect(podman).toContain("--volume=/host/wt:/work:ro");
  const bwrap = new BwrapSandbox({ broker })
    .argv(ro, { network: "none", token: asRunToken("mxr_t") })
    .join(" ");
  expect(bwrap).toContain("--ro-bind /host/wt /host/wt");
  expect(bwrap).not.toContain("--bind /host/wt /host/wt");
});

test("sandboxes refuse to launch with the real key in env or argv", async () => {
  const realKey = "k".repeat(20);
  const executor: LineExecutor = async () => ({
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    stderrTail: "",
  });
  const podman = new PodmanSandbox({ broker, image: "img", executor });
  await expect(
    podman.exec({
      workdir: "/host/wt",
      cmd: ["true"],
      env: { LEAK: realKey },
      network: "none",
      timeoutMs: 1000,
    }),
  ).rejects.toThrow(/real gateway credential/);
  await expect(
    podman.exec({
      workdir: "/host/wt",
      cmd: ["echo", Buffer.from(realKey).toString("base64")],
      network: "none",
      timeoutMs: 1000,
    }),
  ).rejects.toThrow(/real gateway credential/);
  const bwrap = new BwrapSandbox({ broker, executor });
  await expect(
    bwrap.exec({
      workdir: "/host/wt",
      cmd: ["true"],
      env: { LEAK: realKey },
      network: "none",
      timeoutMs: 1000,
    }),
  ).rejects.toThrow(/real gateway credential/);
});
