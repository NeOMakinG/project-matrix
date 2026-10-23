import type { BaselineRun } from "./check-baseline.js";
import {
  checkInvocation,
  MAX_PARSE_BYTES,
  parseCheckOutput,
  resolveParser,
} from "./check-parsers.js";
import { phaseResources, phaseTimeoutMs } from "./models.js";
import type { Sandbox, SandboxExecResult } from "./ports.js";
import type { PhaseContext } from "./ports-internal.js";
import type { CheckCommand } from "./types.js";

const token = () => globalThis.crypto.randomUUID();

/**
 * Runs one check in the sandbox with the project's `checks` resources. With `structured`, the
 * check writes its report to a file under REPORT_MOUNT (read back host-side, byte-capped) and its
 * failures are parsed; `roots` are stripped from paths so branch and base identities line up.
 */
export async function runCheck(
  sandbox: Sandbox,
  ctx: PhaseContext,
  check: CheckCommand,
  options: { structured: boolean; workdir?: string; roots?: readonly string[]; label?: string },
): Promise<{ res: SandboxExecResult; run: BaselineRun; cmd: string[]; ms: number }> {
  const workdir = options.workdir ?? ctx.workdir;
  const inv = options.structured ? checkInvocation(check, token()) : { cmd: check.cmd };
  const resources = phaseResources(ctx.project, "checks");
  ctx.emit(`${options.label ?? "running"} ${check.kind}: ${inv.cmd.join(" ")}`, "tool");
  const started = Date.now();
  const res = await sandbox.exec(
    {
      workdir,
      cmd: inv.cmd,
      ...("env" in inv && inv.env ? { env: inv.env } : {}),
      network: "none",
      timeoutMs: phaseTimeoutMs(ctx.project, "checks"),
      maxOutputBytes: MAX_PARSE_BYTES,
      ...(resources ? { resources } : {}),
      ...("report" in inv && inv.report ? { report: inv.report } : {}),
    },
    ctx.signal,
  );
  const failures = options.structured
    ? parseCheckOutput(resolveParser(check), res, options.roots ?? [workdir, "/work"])
    : null;
  return { res, run: { code: res.code, failures }, cmd: inv.cmd, ms: Date.now() - started };
}
