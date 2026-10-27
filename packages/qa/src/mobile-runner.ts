import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

/** Runs an argv on some host (locally, or on the device host over SSH). Never through a local shell. */
export interface CommandRunner {
  run(
    argv: string[],
    /** `signal` aborts the command: locally its whole process group is killed. */
    options?: { timeoutMs?: number; stdin?: string; signal?: AbortSignal },
  ): Promise<CommandResult>;
}

const MAX_STDOUT = 64 * 1024 * 1024;

export function localRunner(): CommandRunner {
  return {
    run: (argv, options = {}) =>
      new Promise((resolve, reject) => {
        const [cmd, ...args] = argv;
        if (!cmd) return reject(new Error("empty command"));
        const signal = options.signal;
        // An abortable command leads its own process group so the abort reaches its children.
        const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], detached: !!signal });
        const out: Buffer[] = [];
        let size = 0;
        let err = "";
        const kill = () => {
          try {
            if (signal && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        const timer = setTimeout(kill, options.timeoutMs ?? 120_000);
        if (signal?.aborted) kill();
        signal?.addEventListener("abort", kill, { once: true });
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
        // Leftovers of an abortable command are killed on exit (they may hold its pipes open).
        child.on("exit", () => {
          if (signal && child.pid)
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // the group is already gone
            }
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", kill);
          // An abortable command owns its group: reap whatever it left running.
          if (signal && child.pid)
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // the group is already gone
            }
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
