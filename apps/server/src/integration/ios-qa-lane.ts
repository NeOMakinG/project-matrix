import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  type AgentQaOutcome,
  type AgentQaPort,
  type AgentQaRequest,
  type ProjectConfig,
  parseAgentQaReport,
} from "@matrix/core";
import { type CommandRunner, localRunner, sshRunner } from "@matrix/qa";
import { z } from "zod";
import { laneHolder, loadFixtures } from "./agent-qa-lane.js";
import {
  collectLocal,
  newLocalJob,
  PNG,
  qaPrompt,
  REPO_ROOT,
  readManual,
  removeLocalJob,
  runLocalAgent,
  writeTool,
} from "./local-qa-agent.js";

const CHUNK = 96_000;
const appIdRe = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;

export const iosLaneSchema = z.object({
  /** The simulator host (Mac mini running the tapflow relay + agent), key-based SSH. */
  host: z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$/),
  /** The shared tapflow simulator's UDID (never a personal device). */
  udid: z.string().regex(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/),
  bootSimulator: z.boolean().default(false),
  /**
   * Run the PR build under the Seatbelt profile (credentials unreadable, write allow-list).
   * Xcode's own sandboxed tools (coremlc, Swift macros, SwiftPM manifests) cannot run inside it;
   * false runs the build as the simulator host's user: only with a dedicated build account there.
   */
  sandboxBuild: z.boolean().default(true),
  model: z
    .string()
    .regex(/^[a-z0-9.-]{3,60}$/)
    .default("claude-sonnet-5-5"),
  maxLoadPct: z.number().int().min(10).max(400).default(150),
  minFreeGb: z.number().int().min(1).max(2_000).default(15),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(4 * 3_600_000)
    .default(20 * 60_000),
  buildTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(90 * 60_000)
    .default(75 * 60_000),
  agentTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(90 * 60_000)
    .default(25 * 60_000),
  projects: z.record(
    z.string(),
    z.object({
      repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
      build: z.string().min(1).max(4_000),
      /** Path (glob allowed) of the simulator .app relative to the checkout. */
      app: z
        .string()
        .regex(/^[A-Za-z0-9._/*-]{1,200}$/)
        .refine((p) => !p.includes("..") && !p.startsWith("/")),
      appId: z.string().regex(appIdRe),
      fixtures: z
        .object({
          set: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
          note: z.string().min(1).max(2_000),
        })
        .optional(),
    }),
  ),
});
export type IosLaneConfig = z.output<typeof iosLaneSchema>;

const WHAT: Record<number, string> = {
  10: "simulator host overloaded",
  11: "simulator unavailable",
  12: "simulator lane busy",
  20: "iOS build failed",
  21: "iOS install failed",
  255: "simulator host unreachable over SSH",
};

/**
 * iOS driver: builds the PR for the simulator on the Mac mini (`ops/qa-lane/ios-qa.sh` over SSH),
 * installs it on the shared tapflow simulator, then a QA agent on this host drives it through the
 * tapflow relay (MCP) and saves screenshots with `./qa-shot`. One job at a time per process; the
 * mini's lock keeps other tenants out.
 */
export class TapflowIosQaLane implements AgentQaPort {
  #queue: Promise<unknown> = Promise.resolve();
  readonly #remote: CommandRunner;
  readonly #local: CommandRunner;
  readonly #script: string;
  readonly holder: string;

  constructor(
    private readonly config: IosLaneConfig,
    options: { remote?: CommandRunner; local?: CommandRunner; holder?: string } = {},
  ) {
    this.#local = options.local ?? localRunner();
    this.#remote = options.remote ?? sshRunner(config.host, this.#local);
    this.#script = readFileSync(join(REPO_ROOT, "ops", "qa-lane", "ios-qa.sh"), "utf8");
    this.holder = laneHolder(options.holder ?? `${hostname()}-ios-${process.pid}`);
  }

  handles(project: ProjectConfig): boolean {
    return this.config.projects[project.id] !== undefined;
  }

  run(request: AgentQaRequest): Promise<AgentQaOutcome> {
    const next = this.#queue.then(() => this.#run(request));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #step(args: string[], timeoutMs: number): Promise<string> {
    const r = await this.#remote.run(["bash", "-s", "--", ...args], {
      stdin: this.#script,
      timeoutMs,
    });
    if (r.exitCode !== 0) {
      const lines = r.stderr.toString().trim().split("\n");
      // The script prints the first real errors before the tail: keep those when present.
      const errors = lines.filter((l) =>
        /(^|\s|: )error: |nonzero exit code|npm ERR!|ERR_PNPM|^Error: /.test(l),
      );
      const tail = (errors.length ? errors.slice(0, 4) : lines.slice(-6)).join(" ").slice(0, 600);
      throw new Error(`${WHAT[r.exitCode] ?? `${args[0]} failed (${r.exitCode})`}: ${tail}`);
    }
    return r.stdout.toString();
  }

  async #run(request: AgentQaRequest): Promise<AgentQaOutcome> {
    const c = this.config;
    const project = c.projects[request.project.id];
    if (!project) return { kind: "blocked", reason: "no iOS lane settings for this project" };
    if (project.repo.toLowerCase() !== request.pullRequest.repo.toLowerCase())
      return { kind: "blocked", reason: "the draft PR is not on the iOS lane's repository" };
    if (!/^[a-f0-9]{40}$/.test(request.headSha))
      return { kind: "blocked", reason: "invalid head SHA" };
    const started = Date.now();
    const job = newLocalJob();
    const device: { serial: string; model?: string; os?: string } = { serial: c.udid };
    const build: { appId: string; kind: string; version?: string } = {
      appId: project.appId,
      kind: "release, simulator",
    };
    let locked = false;
    try {
      // Two rounds: the simulator host may be briefly overloaded or the sim mid-reboot.
      let info: string | undefined;
      let last = "";
      for (let round = 0; round < 2 && info === undefined; round++) {
        if (round) await new Promise((r) => setTimeout(r, 60_000));
        try {
          info = await this.#step(
            [
              "precheck",
              c.udid,
              c.bootSimulator ? "1" : "0",
              String(c.maxLoadPct),
              String(c.minFreeGb),
            ],
            5 * 60_000,
          );
        } catch (error) {
          last = (error as Error).message;
        }
      }
      if (info === undefined)
        throw new Error(
          `the iOS simulator stayed unavailable after retries (${last.slice(0, 200)})`,
        );
      const model = info.match(/^model=(.{1,60})$/m)?.[1];
      const os = info.match(/^os=(.{1,30})$/m)?.[1];
      if (model) device.model = model;
      if (os) device.os = os;
      await this.#step(
        ["lock", job.id, String(Math.round(c.waitMs / 1000)), this.holder],
        c.waitMs + 60_000,
      );
      locked = true;
      const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
      await this.#step(
        ["write", job.id, "build.sh", b64(`set -euo pipefail\n${project.build}\n`)],
        60_000,
      );
      await this.#step(
        [
          "build",
          job.id,
          project.repo,
          String(request.pullRequest.number),
          request.headSha,
          String(Math.round(c.buildTimeoutMs / 1000)),
          project.appId,
          c.sandboxBuild ? "1" : "0",
        ],
        c.buildTimeoutMs + 10 * 60_000,
      );
      const version = (
        await this.#step(["install", job.id, c.udid, project.app, project.appId], 10 * 60_000)
      ).trim();
      if (/^[\w.+() -]{1,40}$/.test(version)) build.version = version;
      if (project.fixtures) await this.#seed(job.id, project.fixtures.set);
      this.#writeShotTool(job.dir);
      const intro = `Test the draft PR https://github.com/${project.repo}/pull/${request.pullRequest.number} at commit ${request.headSha} on the iOS simulator. The PR's simulator build of \`${project.appId}\` is installed and was just launched on the simulator with UDID ${c.udid} (${device.model ?? "iPhone"}, ${device.os ?? "iOS"}). Drive it ONLY through the tapflow MCP tools: call list_devices, pick the device whose id/name matches that UDID (never any other device), connect_device, then query_ui_tree / tap / swipe / type_text / press_key / press_button. Save evidence screenshots with \`./qa-shot <name>\` (writes out/shots/<name>.png) and reference those names in report.json. Write out/report.json (you can only write under out/).`;
      writeFileSafe(
        job.dir,
        "prompt.md",
        qaPrompt(readManual(), request, intro, project.fixtures?.note),
      );
      await runLocalAgent(this.#local, job.dir, "ios", c.model, c.agentTimeoutMs);
      const files = collectLocal(job.dir);
      for (const line of (await this.#step(["collect", job.id], 5 * 60_000)).split("\n")) {
        const [name, data] = line.split("\t");
        if (name && data && !files.has(name)) files.set(name, Buffer.from(data, "base64"));
      }
      const report = parseAgentQaReport(files.get("report.json")?.toString("utf8") ?? "");
      if (!report)
        return { kind: "blocked", reason: "the QA agent's report.json is invalid", device, build };
      const screenshots = [...files]
        .filter(([n, b]) => n.endsWith(".png") && b.subarray(0, 8).equals(PNG))
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
      return { kind: "blocked", reason: (error as Error).message.slice(0, 600), device, build };
    } finally {
      if (locked) await this.#step(["unlock", job.id], 60_000).catch(() => undefined);
      await this.#step(["cleanup", job.id], 60_000).catch(() => undefined);
      removeLocalJob(job.dir);
    }
  }

  async #seed(job: string, set: string): Promise<void> {
    const files = loadFixtures(join(REPO_ROOT, "ops", "qa-lane", "fixtures"), set);
    const hash = createHash("sha256");
    for (const { name, bytes } of files) {
      hash.update(name).update(bytes);
      const data = bytes.toString("base64");
      for (let at = 0; at < data.length || at === 0; at += CHUNK)
        await this.#step(
          [at === 0 ? "write" : "append", job, `fx-${name}`, data.slice(at, at + CHUNK)],
          60_000,
        );
    }
    const out = await this.#step(
      ["seed", job, this.config.udid, `${set}-${hash.digest("hex").slice(0, 12)}`],
      10 * 60_000,
    );
    console.error(`[ios-qa-lane] ${out.trim().slice(0, 120)}`);
  }

  /** `./qa-shot <name>`: a simulator screenshot into out/shots/, via the fixed SSH step. */
  #writeShotTool(dir: string): void {
    const home = homedir();
    const script = join(REPO_ROOT, "ops", "qa-lane", "ios-qa.sh");
    writeTool(
      dir,
      "qa-shot",
      `#!/usr/bin/env bash
set -euo pipefail
n="\${1:-}"; n="\${n%.png}"
[[ "$n" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$ ]] || { echo "usage: ./qa-shot <name>" >&2; exit 2; }
out="$(cd "$(dirname "$0")" && pwd)/out/shots/$n.png"
ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=15 -i ${q(join(home, ".ssh", "id_ed25519"))} -o UserKnownHostsFile=${q(join(home, ".ssh", "known_hosts"))} ${q(this.config.host)} bash -s -- shot ${this.config.udid} <${q(script)} | base64 -d >"$out"
echo "saved out/shots/$n.png"
`,
    );
  }
}

function q(s: string): string {
  if (!/^[A-Za-z0-9_./@:-]+$/.test(s)) throw new Error(`unsafe path for the shot tool: ${s}`);
  return `'${s}'`;
}

function writeFileSafe(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, name), text, { mode: 0o600 });
}
