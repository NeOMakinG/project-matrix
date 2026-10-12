import { spawn } from "node:child_process";
import { lstat, realpath, statfs } from "node:fs/promises";
import { connect } from "node:net";
import { freemem, release, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const OUTPUT_CAP = 16_384;
const SYSTEM_TOOL_DIRECTORIES = ["/usr/bin", "/bin"];
const TOOL_NAMES = new Set(["bun", "git", "podman", "bwrap", "gitleaks", "orca", "tailscale"]);
export interface DoctorAdapters {
  platform: string;
  release: string;
  env: Record<string, string | undefined>;
  command(name: string, args: string[], signal: AbortSignal): Promise<string>;
  postgres(host: string, port: number, signal: AbortSignal): Promise<void>;
  get(url: URL, token: string | undefined, signal: AbortSignal): Promise<string>;
  resources(): Promise<{ ram: number; disk: number }>;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function localAdapters(approvedDirectories: readonly string[] = []): DoctorAdapters {
  const env = process.env;
  const directories = [
    ...(process.platform === "win32" ? [] : SYSTEM_TOOL_DIRECTORIES),
    ...approvedDirectories,
  ];
  if (directories.some((directory) => !isAbsolute(directory) || resolve(directory) !== directory))
    throw new Error("invalid trusted tools directory");
  return {
    platform: process.platform,
    release: release(),
    env,
    async command(name, args, signal) {
      if (!TOOL_NAMES.has(name)) throw new Error("tool unavailable");
      const roots = [process.cwd(), await realpath(process.cwd())];
      let ancestor = roots[1] ?? process.cwd();
      for (;;) {
        if (
          (await lstat(join(ancestor, "package.json")).catch(() => undefined)) ||
          (await lstat(join(ancestor, "matrix.config.ts")).catch(() => undefined))
        )
          roots.push(ancestor);
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      const trustedDirectories: string[] = [];
      for (const directory of directories) {
        if (roots.some((root) => inside(root, directory))) continue;
        const resolved = await realpath(directory).catch(() => undefined);
        const entry = await lstat(directory).catch(() => undefined);
        if (resolved === directory && entry?.isDirectory() && !(entry.mode & 0o022))
          trustedDirectories.push(directory);
      }
      let binary: string | undefined;
      if (name === "bun" && process.versions.bun) {
        const runtime = process.execPath;
        const resolved = await realpath(runtime).catch(() => undefined);
        const entry = await lstat(runtime).catch(() => undefined);
        if (
          isAbsolute(runtime) &&
          resolved === runtime &&
          entry?.isFile() &&
          !(entry.mode & 0o022) &&
          !roots.some((root) => inside(root, runtime))
        )
          binary = runtime;
      }
      for (const directory of trustedDirectories) {
        if (binary) break;
        const executable = process.platform === "win32" ? `${name}.exe` : name;
        const path = join(directory, executable);
        const candidate = await realpath(path).catch(() => undefined);
        const entry = await lstat(path).catch(() => undefined);
        if (
          candidate === path &&
          entry?.isFile() &&
          !(entry.mode & 0o022) &&
          !roots.some((root) => inside(root, candidate))
        ) {
          binary = path;
          break;
        }
      }
      if (!binary) throw new Error("tool unavailable");
      return new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
          cwd: tmpdir(),
          shell: false,
          signal,
          env: {
            PATH: trustedDirectories.join(delimiter),
            ...(env.HOME ? { HOME: env.HOME } : {}),
            ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
            ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let bytes = 0;
        const collect = (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > OUTPUT_CAP) {
            child.kill("SIGKILL");
            reject(new Error("output limit"));
          } else output += chunk.toString("utf8");
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0 && bytes <= OUTPUT_CAP) resolve(output);
          else reject(new Error("tool check failed"));
        });
        signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
      });
    },
    postgres(host, port, signal) {
      return new Promise((resolve, reject) => {
        const socket = connect({ host, port, signal });
        socket.on("connect", () => socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
        socket.once("data", (data) => {
          socket.destroy();
          if (data.length === 1 && (data[0] === 83 || data[0] === 78)) resolve();
          else reject(new Error("not PostgreSQL"));
        });
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("connection closed")));
      });
    },
    async get(url, token, signal) {
      const response = await fetch(url, {
        signal,
        redirect: "error",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("HTTP check failed");
      }
      const reader = response.body?.getReader();
      if (!reader) return "";
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > OUTPUT_CAP) throw new Error("output limit");
          chunks.push(chunk.value);
        }
        return Buffer.concat(chunks).toString("utf8");
      } finally {
        await reader.cancel();
      }
    },
    async resources() {
      const disk = await statfs(process.cwd());
      return { ram: freemem(), disk: disk.bavail * disk.bsize };
    },
  };
}
