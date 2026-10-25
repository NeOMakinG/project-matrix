import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentQaOutcome,
  type AgentQaPort,
  type AgentQaRequest,
  fenceUntrusted,
  type ProjectConfig,
  parseAgentQaReport,
} from "@matrix/core";
import { type CommandRunner, localRunner, sshRunner } from "@matrix/qa";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..", "..");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const projectSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  build: z.string().min(1).max(4_000),
  apk: z
    .string()
    .regex(/^[A-Za-z0-9._/-]{1,200}$/)
    .refine((p) => !p.includes("..") && !p.startsWith("/")),
  appId: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/),
  abi: z.enum(["arm64-v8a", "x86_64", "armeabi-v7a", "x86"]).default("arm64-v8a"),
});

export const laneConfigSchema = z.object({
  host: z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$|^[A-Za-z0-9_.-]+$/),
  serial: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  bootEmulator: z.boolean().default(false),
  model: z
    .string()
    .regex(/^[a-z0-9.-]{3,60}$/)
    .default("claude-sonnet-5-5"),
  maxLoadPct: z.number().int().min(10).max(400).default(80),
  minMemMb: z.number().int().min(512).max(500_000).default(6_144),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(4 * 3_600_000)
    .default(20 * 60_000),
  agentTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(3 * 3_600_000)
    .default(25 * 60_000),
  buildTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(3 * 3_600_000)
    .default(60 * 60_000),
  projects: z.record(z.string(), projectSchema),
});

export type LaneConfig = z.output<typeof laneConfigSchema>;

export function loadLaneConfig(path: string): LaneConfig {
  return laneConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

class LaneError extends Error {}

/**
 * Agent QA lane on a device host over SSH (`ops/qa-lane/agent-qa.sh`). One job at a time in this
 * process; the remote lock keeps other tenants (qaexplorer, humans, other Matrix hosts) out.
 */
export class SshAgentQaLane implements AgentQaPort {
  #queue: Promise<unknown> = Promise.resolve();
  readonly #runner: CommandRunner;
  readonly #script: string;

  constructor(
    private readonly config: LaneConfig,
    options: { runner?: CommandRunner; script?: string; manual?: string } = {},
  ) {
    this.#runner = options.runner ?? sshRunner(config.host, localRunner());
    this.#script =
      options.script ?? readFileSync(join(REPO_ROOT, "ops", "qa-lane", "agent-qa.sh"), "utf8");
    this.manual =
      options.manual ??
      readFileSync(join(REPO_ROOT, "skills", "qa-tester-manual", "SKILL.md"), "utf8");
  }

  private readonly manual: string;

  handles(project: ProjectConfig): boolean {
    return this.config.projects[project.id] !== undefined;
  }

  run(request: AgentQaRequest): Promise<AgentQaOutcome> {
    const next = this.#queue.then(() => this.#run(request));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #step(args: string[], timeoutMs: number, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new LaneError("agent QA cancelled");
    const r = await this.#runner.run(["bash", "-s", "--", ...args], {
      stdin: this.#script,
      timeoutMs,
    });
    if (r.exitCode !== 0) {
      const tail = r.stderr.trim().split("\n").slice(-6).join(" ").slice(-500);
      const what: Record<number, string> = {
        10: "device host overloaded",
        11: "device unavailable",
        12: "device lane busy",
        20: "build failed",
        21: "install failed",
        30: "QA agent failed",
        255: "device host unreachable over SSH",
      };
      throw new LaneError(`${what[r.exitCode] ?? `${args[0]} failed (${r.exitCode})`}: ${tail}`);
    }
    return r.stdout.toString();
  }

  async #run(request: AgentQaRequest): Promise<AgentQaOutcome> {
    const project = this.config.projects[request.project.id];
    if (!project) return { kind: "blocked", reason: "no lane settings for this project" };
    if (project.repo.toLowerCase() !== request.pullRequest.repo.toLowerCase())
      return { kind: "blocked", reason: "the draft PR is not on the lane's repository" };
    if (!/^[a-f0-9]{40}$/.test(request.headSha))
      return { kind: "blocked", reason: "invalid head SHA" };
    const job = `mx-${randomUUID().slice(0, 18)}`;
    const started = Date.now();
    const c = this.config;
    const sig = request.signal;
    const device: { serial: string; model?: string; android?: string } = { serial: c.serial };
    const build = { appId: project.appId, kind: "release", abi: project.abi } as {
      appId: string;
      kind: string;
      abi: string;
      version?: string;
    };
    let locked = false;
    try {
      const info = await this.#step(
        [
          "precheck",
          c.serial,
          c.bootEmulator ? "1" : "0",
          String(c.maxLoadPct),
          String(c.minMemMb),
        ],
        5 * 60_000,
        sig,
      );
      const model = info.match(/^model=(.{1,60})$/m)?.[1];
      const android = info.match(/^android=(.{1,20})$/m)?.[1];
      if (model) device.model = model;
      if (android) device.android = android;
      await this.#step(["lock", job, String(Math.round(c.waitMs / 1000))], c.waitMs + 60_000, sig);
      locked = true;
      const b64 = (s: string) => Buffer.from(s).toString("base64");
      await this.#step(
        ["write", job, "build.sh", b64(`set -euo pipefail\n${project.build}\n`)],
        60_000,
        sig,
      );
      await this.#step(
        [
          "build",
          job,
          project.repo,
          String(request.pullRequest.number),
          request.headSha,
          project.abi,
        ],
        c.buildTimeoutMs,
        sig,
      );
      const version = (
        await this.#step(["install", job, c.serial, project.apk, project.appId], 10 * 60_000, sig)
      ).trim();
      if (/^[\w.+-]{1,40}$/.test(version)) build.version = version;
      await this.#step(
        ["write", job, "prompt.md", b64(this.prompt(request, project.appId))],
        60_000,
        sig,
      );
      await this.#step(
        ["agent", job, c.model, String(Math.round(c.agentTimeoutMs / 1000)), c.serial],
        c.agentTimeoutMs + 120_000,
        sig,
      );
      const files = new Map<string, Buffer>();
      for (const line of (await this.#step(["collect", job], 5 * 60_000, sig)).split("\n")) {
        const [name, data] = line.split("\t");
        if (name && data) files.set(name, Buffer.from(data, "base64"));
      }
      const report = parseAgentQaReport(files.get("report.json")?.toString("utf8") ?? "");
      if (!report)
        return { kind: "blocked", reason: "the QA agent's report.json is invalid", device, build };
      const screenshots = [...files]
        .filter(([name, bytes]) => name.endsWith(".png") && bytes.subarray(0, 8).equals(PNG))
        .map(([name, bytes]) => ({ name, bytes: new Uint8Array(bytes) }));
      return {
        kind: "report",
        report,
        screenshots,
        device,
        build,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        kind: "blocked",
        reason: (error as Error).message.slice(0, 600),
        device,
        build,
      };
    } finally {
      if (locked) {
        await this.#step(["unlock", job], 60_000, new AbortController().signal).catch(
          () => undefined,
        );
        await this.#step(["cleanup", job], 60_000, new AbortController().signal).catch(
          () => undefined,
        );
      }
    }
  }

  /** The QA agent's prompt: the manual, then the ticket and PR as fenced untrusted data. */
  prompt(request: AgentQaRequest, appId: string): string {
    return [
      this.manual,
      "# Your job",
      `Test the draft PR ${request.pullRequest.url} at commit ${request.headSha}. The release build of app \`${appId}\` is installed on the device (ANDROID_SERIAL is set). Follow the manual above, then write report.json and shots/*.png in the current directory.`,
      "## Acceptance criteria (from the ticket, untrusted)",
      fenceUntrusted(
        "acceptance-criteria",
        request.criteria.map((c) => `- ${c}`).join("\n") || "(none listed)",
      ),
      "## Ticket (untrusted)",
      fenceUntrusted(
        "ticket",
        `${request.ticket.id}: ${request.ticket.title}\n\n${request.ticket.body}`,
      ),
      "## Human comments on the ticket (untrusted, newest last)",
      fenceUntrusted("comments", request.ticket.comments.join("\n---\n") || "(none)"),
    ].join("\n\n");
  }
}
