import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { OrcaCli, record, str } from "@matrix/workspace";

/** The slice of the Orca CLI the deploy route uses (tests inject a fake). */
export interface OrcaCaller {
  call(args: string[], timeoutMs?: number): Promise<unknown>;
}

export interface OrcaRoute {
  /** Paired Orca runtime that holds the deploy CLI and its auth (e.g. `macbook-pro`). */
  environment: string;
  /** GitHub `owner/name` -> absolute repo path on that host (an Orca-registered repo). */
  repos: Record<string, string>;
}

export interface OrcaRunResult {
  exitCode: number;
  stdout: string;
  /** stdout tail + stderr tail (unredacted; the caller redacts). */
  output: string;
  /** What happened on the route (worktree, terminal, cleanup), for receipts. */
  trace: string[];
}

const SHA = /^[0-9a-f]{40}$/;
/** Lines one terminal keeps (measured: 2000); the payload must fit well inside it. */
const PAYLOAD_LINES = 1_500;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Shell run inside the Orca terminal. All output goes to private temp files; the terminal only
 * ever shows one framed payload (gzip + base64, bounded) so a small scrollback still carries it.
 * Markers are printed through printf formats so the script text never contains them.
 */
export function routeScript(input: {
  nonce: string;
  argv: string[];
  checkout?: { sha: string };
}): string {
  const steps = input.checkout
    ? [
        `git fetch --quiet origin ${input.checkout.sha}`,
        `git checkout --quiet --detach ${input.checkout.sha}`,
        `test "$(git rev-parse HEAD)" = ${input.checkout.sha}`,
      ]
    : [];
  const run = [...steps, input.argv.map(q).join(" ")].join(" && ");
  return [
    "set -u",
    'd="$(mktemp -d)"',
    `( ${run} ) >"$d/out" 2>"$d/err" </dev/null`,
    "rc=$?",
    'pack() { head -c "$1" "$d/out" >"$d/o"; { printf "rc=%s out=%s\\n" "$rc" "$(wc -c <"$d/o" | tr -d " ")"; cat "$d/o"; tail -c 16000 "$d/err"; } | gzip -c | base64 | fold -w 120 >"$d/p"; }',
    "pack 2000000",
    `[ "$(wc -l <"$d/p")" -gt ${PAYLOAD_LINES} ] && pack 60000`,
    `printf '__MX%s_%s__\\n' B ${input.nonce}`,
    'cat "$d/p"',
    `printf '__MX%s_%s__\\n' E ${input.nonce}`,
    'rm -rf "$d"',
  ].join("\n");
}

/** Decodes the framed payload out of terminal lines; undefined until the end marker shows. */
export function decodePayload(
  lines: string[],
  nonce: string,
): { exitCode: number; stdout: string; output: string } | undefined {
  const trimmed = lines.map((l) => l.trim());
  const begin = trimmed.lastIndexOf(`__MXB_${nonce}__`);
  const end = trimmed.lastIndexOf(`__MXE_${nonce}__`);
  if (begin < 0 || end <= begin) return undefined;
  const raw = gunzipSync(
    Buffer.from(
      trimmed
        .slice(begin + 1, end)
        .join("")
        .replace(/\s/g, ""),
      "base64",
    ),
  );
  const nl = raw.indexOf(10);
  const header = raw.subarray(0, nl).toString("utf8");
  const m = /^rc=(\d+) out=(\d+)$/.exec(header);
  if (!m) throw new Error(`orca route: bad payload header ${JSON.stringify(header.slice(0, 40))}`);
  const outLen = Number(m[2]);
  const stdout = raw.subarray(nl + 1, nl + 1 + outLen).toString("utf8");
  const stderr = raw.subarray(nl + 1 + outLen).toString("utf8");
  return {
    exitCode: Number(m[1]),
    stdout,
    output: `${stdout.slice(-16_000)}\n${stderr}`,
  };
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one argv on a paired Orca host without SSH: a throwaway Orca worktree of the repo, a
 * terminal running a fixed script (clean detached checkout of `sha` when asked), the framed
 * result read back, then the terminal and worktree are always removed.
 */
export async function runViaOrca(
  route: OrcaRoute,
  argv: string[],
  opts: {
    repo: string;
    checkout?: { sha: string };
    timeoutMs: number;
    signal?: AbortSignal;
    cli?: OrcaCaller;
    binary?: string;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    label?: string;
  },
): Promise<OrcaRunResult> {
  const repoPath = route.repos[opts.repo];
  if (!repoPath) throw new Error(`orca route ${route.environment}: no repo path for ${opts.repo}`);
  if (opts.checkout && !SHA.test(opts.checkout.sha))
    throw new Error("orca route: checkout needs a full commit sha");
  const cli =
    opts.cli ??
    new OrcaCli({
      environment: route.environment,
      ...(opts.binary ? { binary: opts.binary } : {}),
    });
  const sleep = opts.sleep ?? sleepMs;
  const nonce = randomBytes(8).toString("hex");
  const name = `mx-${opts.label ?? "deploy"}-${(opts.checkout?.sha ?? "run").slice(0, 8)}-${nonce.slice(0, 6)}`;
  const trace: string[] = [];
  let worktree: string | undefined;
  let terminal: string | undefined;
  try {
    const created = record(
      await cli.call(
        [
          "worktree",
          "create",
          "--repo",
          `path:${repoPath}`,
          "--name",
          name,
          "--setup",
          "skip",
          "--no-parent",
          "--json",
        ],
        180_000,
      ),
    );
    worktree = str(record(created.worktree).path);
    if (!worktree) throw new Error("orca route: worktree create returned no path");
    trace.push(`${route.environment}: worktree ${worktree}`);
    const script = routeScript({
      nonce,
      argv,
      ...(opts.checkout ? { checkout: opts.checkout } : {}),
    });
    const command = `/bin/sh -c "$(printf %s ${Buffer.from(script).toString("base64")} | base64 -d)"`;
    const made = record(
      await cli.call([
        "terminal",
        "create",
        "--worktree",
        `path:${worktree}`,
        "--title",
        name,
        "--command",
        command,
        "--json",
      ]),
    );
    terminal = str(record(made.terminal).handle);
    if (!terminal) throw new Error("orca route: terminal create returned no handle");
    trace.push(`${route.environment}: terminal ${terminal} runs ${argv.join(" ")}`);
    const lines: string[] = [];
    let cursor: string | undefined;
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      if (opts.signal?.aborted) throw new Error("orca route: cancelled");
      const read = record(
        record(
          await cli.call([
            "terminal",
            "read",
            "--terminal",
            terminal,
            "--limit",
            "2000",
            ...(cursor ? ["--cursor", cursor] : []),
            "--json",
          ]),
        ).terminal,
      );
      const tail = Array.isArray(read.tail) ? read.tail.map(String) : [];
      lines.push(...tail);
      if (lines.length > 6_000) lines.splice(0, lines.length - 6_000);
      cursor = str(read.nextCursor) ?? cursor;
      const got = decodePayload(lines, nonce);
      if (got) return { ...got, trace };
      if (Date.now() >= deadline)
        return { exitCode: 124, stdout: "", output: "timed out on the orca route", trace };
      await sleep(opts.pollMs ?? 3_000);
    }
  } finally {
    if (terminal)
      await cli
        .call(["terminal", "close", "--terminal", terminal, "--json"])
        .then(() => trace.push(`${route.environment}: terminal closed`))
        .catch((e: Error) => trace.push(`terminal close failed: ${e.message.slice(0, 120)}`));
    if (worktree)
      await cli
        .call(["worktree", "rm", "--worktree", `path:${worktree}`, "--force", "--json"], 180_000)
        .then(() => trace.push(`${route.environment}: worktree removed`))
        .catch((e: Error) => trace.push(`worktree rm failed: ${e.message.slice(0, 120)}`));
  }
}
