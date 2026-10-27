import { lookup } from "node:dns/promises";
import { isPrivateAddress, publicHttpsProblem } from "@matrix/core";
import { redact } from "@matrix/monitor";
import { hostExecutor, type LineExecutor, runToCompletion } from "@matrix/sandbox";
import type { DeployHost } from "./deploy-plan.js";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface HostRun {
  exitCode: number;
  stdout: string;
  tail: string;
}

/** Runs an argv on a deploy host (local, or ssh BatchMode with a fixed script on stdin). */
export async function runOnHost(
  host: DeployHost,
  argv: string[],
  opts: {
    executor?: LineExecutor;
    timeoutMs?: number;
    signal?: AbortSignal;
    checkout?: { repo: string; sha: string };
  } = {},
): Promise<HostRun> {
  const body = opts.checkout
    ? [
        "set -eu",
        'dir="$(mktemp -d)"',
        "trap 'rm -rf \"$dir\"' EXIT",
        `gh repo clone ${q(opts.checkout.repo)} "$dir" -- --quiet --filter=blob:none --no-checkout`,
        'cd "$dir"',
        `git checkout --quiet --detach ${q(opts.checkout.sha)}`,
        argv.map(q).join(" "),
      ].join("\n")
    : argv.map(q).join(" ");
  const cmd =
    host.transport === "local"
      ? ["/bin/sh", "-c", body]
      : [
          "ssh",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=15",
          "-o",
          "ForwardAgent=no",
          host.ssh as string,
          "/bin/sh -l -s",
        ];
  const result = await runToCompletion(
    opts.executor ?? hostExecutor,
    {
      cmd,
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
      timeoutMs: opts.timeoutMs ?? 120_000,
      ...(host.transport === "ssh" ? { stdin: body } : {}),
    },
    opts.signal,
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    tail: redactTail(`${result.stdout}\n${result.stderrTail}`),
  };
}

/** Last lines of command output with secret-looking values removed (receipts, Linear). */
export function redactTail(text: string, lines = 15): string {
  const masked = redact(text).replace(
    /\b(?:fo1_|FlyV1 |ghp_|gho_|github_pat_|sk-|xox[bp]-|eyJ)[A-Za-z0-9_\-.=+/]{8,}/g,
    "<redacted>",
  );
  return masked
    .split("\n")
    .filter((l) => l.trim())
    .slice(-lines)
    .join("\n")
    .slice(-2_000);
}

export interface FlyRelease {
  version: number;
  status: string;
  user: string;
  createdAt: string;
  image: string;
}

export async function flyReleases(
  host: DeployHost,
  app: string,
  executor?: LineExecutor,
): Promise<FlyRelease[]> {
  const r = await runOnHost(host, ["fly", "releases", "-a", app, "--json", "--image"], {
    ...(executor ? { executor } : {}),
  });
  if (r.exitCode !== 0) throw new Error(`fly releases failed: ${r.tail.slice(-300)}`);
  const list = JSON.parse(r.stdout || "[]") as {
    Version?: number;
    Status?: string;
    User?: { Email?: string };
    CreatedAt?: string;
    ImageRef?: string;
  }[];
  return list
    .map((x) => ({
      version: Number(x.Version ?? 0),
      status: String(x.Status ?? ""),
      user: String(x.User?.Email ?? ""),
      createdAt: String(x.CreatedAt ?? ""),
      image: String(x.ImageRef ?? ""),
    }))
    .sort((a, b) => b.version - a.version);
}

export async function flyWhoami(host: DeployHost, executor?: LineExecutor): Promise<string> {
  const r = await runOnHost(host, ["fly", "auth", "whoami"], { ...(executor ? { executor } : {}) });
  if (r.exitCode !== 0) throw new Error("fly auth whoami failed on the deploy host");
  return r.stdout.trim().split("\n").at(-1)?.trim() ?? "";
}

/** Refuses non-public health targets, including hostnames resolving to private addresses. */
export async function assertPublicUrl(
  url: string,
  resolve: (host: string) => Promise<string[]> = async (h) =>
    (await lookup(h, { all: true })).map((a) => a.address),
): Promise<void> {
  const problem = publicHttpsProblem(url);
  if (problem) throw new Error(problem);
  const addresses = await resolve(new URL(url).hostname);
  if (!addresses.length || addresses.some(isPrivateAddress))
    throw new Error(`${new URL(url).hostname} resolves to a private address`);
}
