import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

/** Runs an argv on some host (locally, or on the device host over SSH). Never through a local shell. */
export interface CommandRunner {
  run(argv: string[], options?: { timeoutMs?: number; stdin?: string }): Promise<CommandResult>;
}

const MAX_STDOUT = 64 * 1024 * 1024;

export function localRunner(): CommandRunner {
  return {
    run: (argv, options = {}) =>
      new Promise((resolve, reject) => {
        const [cmd, ...args] = argv;
        if (!cmd) return reject(new Error("empty command"));
        const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
        const out: Buffer[] = [];
        let size = 0;
        let err = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
        child.stdout.on("data", (d: Buffer) => {
          size += d.length;
          if (size <= MAX_STDOUT) out.push(d);
        });
        child.stderr.on("data", (d: Buffer) => {
          err = (err + d.toString()).slice(-4_000);
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out), stderr: err });
        });
        // SSH may exit before reading all of stdin: EPIPE must not crash the server.
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.stdin ?? "");
      }),
  };
}

/** POSIX single-quote quoting for one word of a remote shell command line. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Runs argv on `host` with `ssh` (batch mode); every word is quoted for the remote shell. */
export function sshRunner(host: string, inner: CommandRunner = localRunner()): CommandRunner {
  if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$|^[A-Za-z0-9_.-]+$/.test(host))
    throw new Error("invalid ssh host");
  return {
    run: (argv, options) =>
      inner.run(
        [
          "ssh",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=15",
          "-o",
          "ServerAliveInterval=30",
          host,
          "--",
          argv.map(shellQuote).join(" "),
        ],
        options,
      ),
  };
}
