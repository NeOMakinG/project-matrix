import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

export function sandboxTool(
  command: string,
  args: string[],
  cwd: string,
  writable: string,
  extraEnv: Record<string, string> = {},
) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: writable,
    TMPDIR: writable,
    ...extraEnv,
  };
  const options = {
    cwd,
    env,
    encoding: "utf8" as const,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  };
  if (process.platform === "darwin") {
    const path = JSON.stringify(realpathSync(writable));
    const profile = `(version 1)(deny default)(allow process*)(allow sysctl-read)(allow file-read*)(allow file-write* (subpath ${path}))(deny network*)`;
    return spawnSync("/usr/bin/sandbox-exec", ["-p", profile, command, ...args], options);
  }
  if (process.platform === "linux") {
    return spawnSync(
      "bwrap",
      [
        "--die-with-parent",
        "--unshare-all",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        writable,
        writable,
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--chdir",
        cwd,
        "--",
        command,
        ...args,
      ],
      options,
    );
  }
  throw new Error("toolchain unverifiable: no supported offline sandbox");
}
