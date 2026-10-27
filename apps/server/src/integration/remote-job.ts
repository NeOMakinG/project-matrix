import { gzipSync } from "node:zlib";
/**
 * Script for one remote runner job (implement / checks) on an Orca-routed host. Pure text
 * builder: the Orca route (deploy-orca.ts) runs it in a throwaway worktree and frames its output.
 *
 * Layout: clean detached checkout of the pushed ticket head, the project's setup commands with the
 * host's normal environment, then the job argv under `env -i` (fresh HOME/TMPDIR, only the spec's
 * env) with stdin from a file. The gateway key never crosses Orca: env values equal to the
 * placeholder are filled on the host from its own key source.
 */

export type KeySource = { secrets: string; path?: string } | { envFile: string; name: string };

export interface RemoteJob {
  sha: string;
  setup: string[][];
  argv: string[];
  env: Record<string, string>;
  stdin?: string;
  placeholder?: string;
  key?: KeySource;
  /**
   * After a successful run, write the staged binary diff of everything the job changed to
   * PATCH_FILE (implement). It travels back in the route payload, never through GitHub, so the
   * host-side gates see it before anything is published.
   */
  collect?: boolean;
}

const q = (s: string) => {
  if (s.includes("\u0000")) throw new Error("NUL byte in remote job argument");
  return `'${s.replace(/'/g, `'\\''`)}'`;
};
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA = /^[0-9a-f]{40}$/;
/** Worktree-relative file the collected patch is written to (the route returns it whole). */
export const PATCH_FILE = ".matrix-patch";
/**
 * The prompt rides gzip+base64 inside the route command, which is one exec argument (Linux caps
 * one at 128 KiB): its compressed size is bounded, the final command is checked again.
 */
export const MAX_STDIN_GZ = 40 * 1024;
const b64 = (s: string) => Buffer.from(s).toString("base64");

/** Inner script, run with the key in the environment (`$1` = private temp dir). */
function inner(job: RemoteJob, keyVar: string | undefined): string {
  const env = Object.entries(job.env).map(([k, v]) => {
    if (!NAME.test(k)) throw new Error(`invalid env name ${JSON.stringify(k)}`);
    if (job.placeholder && v === job.placeholder) {
      if (!keyVar) throw new Error("remote job needs a gateway key source");
      return `${k}="$${keyVar}"`;
    }
    return `${k}=${q(v)}`;
  });
  return [
    'd="$1"',
    'mkdir -p "$d/home" "$d/tmp"',
    `exec env -i PATH="$PATH" HOME="$d/home" TMPDIR="$d/tmp" LANG=C.UTF-8 ${env.join(" ")} ${job.argv.map(q).join(" ")} <"$d/in"`,
  ].join("\n");
}

/** The argv the Orca route runs (one `/bin/sh -c`), with its exit code as the job's. */
export function remoteJobArgv(job: RemoteJob): string[] {
  if (!SHA.test(job.sha)) throw new Error("remote job needs a full commit sha");
  if (gzipSync(job.stdin ?? "").length > MAX_STDIN_GZ)
    throw new Error("remote job stdin over the transport limit (40KB compressed)");
  const key = job.key;
  if (key && "secrets" in key && !NAME.test(key.secrets)) throw new Error("bad secret name");
  if (key && "envFile" in key && (!NAME.test(key.name) || !key.envFile.startsWith("/")))
    throw new Error("bad key env file");
  const keyVar = key ? ("secrets" in key ? key.secrets : key.name) : undefined;
  const runInner = 'sh "$d/inner.sh" "$d"';
  const withKey = !key
    ? runInner
    : "secrets" in key
      ? `secrets run${key.path ? ` --path ${q(key.path)}` : ""} -- ${runInner}`
      : `( set -a; . ${q(key.envFile)}; set +a; ${runInner} )`;
  const lines = [
    "set -u",
    `test "$(git rev-parse HEAD)" = ${job.sha} || { echo "remote checkout is not ${job.sha}" >&2; exit 96; }`,
    'd="$(mktemp -d)"',
    // Timeouts and interrupts must not leave prompts or a big HOME behind.
    `trap 'rm -rf "$d"' EXIT HUP INT TERM`,
    `printf %s ${q(gzipSync(job.stdin ?? "").toString("base64"))} | base64 -d | gzip -dc >"$d/in"`,
    `printf %s ${q(b64(inner(job, keyVar)))} | base64 -d >"$d/inner.sh"`,
    ...job.setup.map(
      (c) =>
        `${c.map(q).join(" ")} </dev/null >&2 || { rc=$?; echo "setup failed: ${c.map((x) => x.replace(/[^A-Za-z0-9 ._@/-]/g, "")).join(" ")}" >&2; rm -rf "$d"; exit 95; }`,
    ),
    `${withKey}; rc=$?`,
  ];
  if (job.collect)
    lines.push(
      // Against the verified input commit: commits the agent made itself are collected too.
      `if [ "$rc" = 0 ]; then git add -A && git diff --cached --binary ${job.sha} >${PATCH_FILE} || rc=97; fi`,
    );
  lines.push('rm -rf "$d"', 'exit "$rc"');
  return ["/bin/sh", "-c", lines.join("\n")];
}
