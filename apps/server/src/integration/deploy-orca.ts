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
  /** The `attach` file's bytes, or "too-big" when it could not fit the transport. */
  attachment?: Buffer | "too-big";
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
  /** Keep the END of an oversized stdout (runner logs: the result line is last). */
  keepTail?: boolean;
  /**
   * Worktree-relative file the job writes (a patch, a report): returned whole in its own frame
   * section, never truncated with the logs; `att=-2` when it cannot fit the transport.
   */
  attach?: string;
}): string {
  if (
    input.attach !== undefined &&
    !/^(?!.*\.\.)[A-Za-z0-9_.][A-Za-z0-9_./-]{0,119}$/.test(input.attach)
  )
    throw new Error("orca route: bad attachment path");
  const att = input.attach ? q(input.attach) : "";
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
    // A missing credential must fail fast, never wait on a prompt nobody answers.
    "export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never",
    'd="$(mktemp -d)"',
    `trap 'rm -rf "$d"' EXIT HUP INT TERM`,
    `( ${run} ) >"$d/out" 2>"$d/err" </dev/null`,
    "rc=$?",
    // Attachment: -1 none, -2 too big for the transport, else its byte length (sent whole).
    input.attach
      ? `: >"$d/a"; al=-1; if [ -f ${att} ]; then if [ "$(wc -c <${att} | tr -d " ")" -le 4000000 ]; then cp ${att} "$d/a"; al="$(wc -c <"$d/a" | tr -d " ")"; else al=-2; fi; fi`
      : `: >"$d/a"; al=-1`,
    `pack() { ${input.keepTail ? "tail" : "head"} -c "$1" "$d/out" >"$d/o";` +
      '  { printf "rc=%s out=%s full=%s att=%s\\n" "$rc" "$(wc -c <"$d/o" | tr -d " ")" "$(wc -c <"$d/out" | tr -d " ")" "$al"; cat "$d/o" "$d/a"; tail -c 16000 "$d/err"; } | gzip -c | base64 | fold -w 120 >"$d/p"; }',
    "pack 2000000",
    `[ "$(wc -l <"$d/p")" -gt ${PAYLOAD_LINES} ] && pack 60000`,
    `[ "$(wc -l <"$d/p")" -gt ${PAYLOAD_LINES} ] && pack 4000`,
    `[ "$(wc -l <"$d/p")" -gt ${PAYLOAD_LINES} ] && { : >"$d/a"; al=-2; pack 4000; }`,
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
  /** Runner output keeps its tail (the final result line); a truncated stdout is still a pass. */
  allowTruncated = false,
):
  | { exitCode: number; stdout: string; output: string; attachment?: Buffer | "too-big" }
  | undefined {
  const trimmed = lines.map((l) => l.trim());
  const begin = trimmed.lastIndexOf(`__MXB_${nonce}__`);
  const end = trimmed.lastIndexOf(`__MXE_${nonce}__`);
  if (begin < 0 || end <= begin) return undefined;
  let raw: Buffer;
  try {
    raw = gunzipSync(
      Buffer.from(
        trimmed
          .slice(begin + 1, end)
          .join("")
          .replace(/[^A-Za-z0-9+/=]/g, ""),
        "base64",
      ),
    );
  } catch (e) {
    return {
      exitCode: 126,
      stdout: "",
      output: `orca route: unreadable payload (${(e as Error).message})`,
    };
  }
  const nl = raw.indexOf(10);
  const header = raw.subarray(0, nl).toString("utf8");
  const m = /^rc=(\d+) out=(\d+) full=(\d+)(?: att=(-?\d+))?$/.exec(header);
  if (!m)
    return {
      exitCode: 126,
      stdout: "",
      output: `orca route: bad payload header ${JSON.stringify(header.slice(0, 40))}`,
    };
  const outLen = Number(m[2]);
  const attLen = Math.max(0, Number(m[4] ?? -1));
  const stdout = raw.subarray(nl + 1, nl + 1 + outLen).toString("utf8");
  const attachment =
    m[4] === "-2"
      ? ("too-big" as const)
      : Number(m[4] ?? -1) >= 0
        ? Buffer.from(raw.subarray(nl + 1 + outLen, nl + 1 + outLen + attLen))
        : undefined;
  const stderr = raw.subarray(nl + 1 + outLen + attLen).toString("utf8");
  return {
    ...(attachment ? { attachment } : {}),
    // Truncated stdout never passes as a success: callers parse it (e.g. release JSON).
    exitCode: Number(m[1]) === 0 && Number(m[3]) > outLen && !allowTruncated ? 125 : Number(m[1]),
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
    /** Accept a truncated stdout tail as success (runner logs; never for parsed output). */
    allowTruncated?: boolean;
    /** Worktree-relative file returned whole (see routeScript). */
    attach?: string;
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
  const deadline = Date.now() + opts.timeoutMs;
  const budget = (cap: number) => {
    if (opts.signal?.aborted) throw new Error("orca route: cancelled");
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("orca route: timed out before the command started");
    return Math.min(cap, left);
  };
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
        budget(180_000),
      ),
    );
    worktree = str(record(created.worktree).path);
    if (!worktree) throw new Error("orca route: worktree create returned no path");
    trace.push(`${route.environment}: worktree ${worktree}`);
    const script = routeScript({
      nonce,
      argv,
      ...(opts.checkout ? { checkout: opts.checkout } : {}),
      ...(opts.allowTruncated ? { keepTail: true } : {}),
      ...(opts.attach ? { attach: opts.attach } : {}),
    });
    const command = `/bin/sh -c "$(printf %s ${Buffer.from(script).toString("base64")} | base64 -d)"`;
    // One exec argument on the Orca CLI host (Linux: 128 KiB); refuse before anything runs.
    if (command.length > 120_000)
      throw new Error(`orca route: command too long (${command.length} bytes)`);
    const made = record(
      await cli.call(
        [
          "terminal",
          "create",
          "--worktree",
          `path:${worktree}`,
          "--title",
          name,
          "--command",
          command,
          "--json",
        ],
        budget(120_000),
      ),
    );
    terminal = str(record(made.terminal).handle);
    if (!terminal) throw new Error("orca route: terminal create returned no handle");
    // Short: remote jobs carry whole scripts (base64 stdin included) as argv.
    trace.push(
      `${route.environment}: terminal ${terminal} runs ${argv.join(" ").replace(/\s+/g, " ").slice(0, 160)}`,
    );
    const lines: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      if (opts.signal?.aborted) throw new Error("orca route: cancelled");
      const read = record(
        record(
          await cli.call(
            [
              "terminal",
              "read",
              "--terminal",
              terminal,
              "--limit",
              "2000",
              ...(cursor ? ["--cursor", cursor] : []),
              "--json",
            ],
            Math.max(5_000, Math.min(60_000, deadline - Date.now())),
          ),
        ).terminal,
      );
      const tail = Array.isArray(read.tail) ? read.tail.map(String) : [];
      const next = str(read.nextCursor);
      // Without a cursor the read is the whole retained tail: replace, never append twice.
      if (next) lines.push(...tail);
      else lines.splice(0, lines.length, ...tail);
      if (lines.length > 6_000) lines.splice(0, lines.length - 6_000);
      cursor = next ?? cursor;
      const got = decodePayload(lines, nonce, opts.allowTruncated);
      if (got) return { ...got, trace };
      if (Date.now() >= deadline) {
        // Stop the command before the terminal is closed, so a timed-out deploy is not left
        // running behind a failed receipt; the receipt still says it may have landed.
        for (let i = 0; i < 2; i++)
          await cli
            .call([
              "terminal",
              "send",
              "--terminal",
              terminal,
              "--interrupt",
              "--text",
              "\u0003",
              "--json",
            ])
            .catch(() => undefined);
        return {
          exitCode: 124,
          stdout: "",
          output:
            "timed out on the orca route; interrupted. The command may have partly run: verify re-reads the provider before acting",
          trace,
        };
      }
      await sleep(opts.pollMs ?? 3_000);
    }
  } finally {
    // Older Orca hosts refuse one of the two close forms; worktree rm stops what is left.
    if (terminal && worktree) {
      const closeErrors: string[] = [];
      for (const args of [
        ["terminal", "close", "--terminal", terminal, "--json"],
        ["terminal", "close", "--worktree", `path:${worktree}`, "--all", "--json"],
      ]) {
        const closed = await cli.call(args).then(
          () => true,
          (e: Error) => void closeErrors.push(e.message.slice(0, 100)),
        );
        if (closed) break;
      }
      trace.push(
        closeErrors.length < 2
          ? `${route.environment}: terminal closed`
          : `${route.environment}: terminal left to worktree rm (${closeErrors.join("; ")})`,
      );
    }
    if (worktree)
      await cli
        .call(["worktree", "rm", "--worktree", `path:${worktree}`, "--force", "--json"], 180_000)
        .then(() => trace.push(`${route.environment}: worktree removed`))
        .catch((e: Error) => trace.push(`worktree rm failed: ${e.message.slice(0, 120)}`));
  }
}
