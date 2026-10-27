import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
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
/** Base64 per ssh argument: one remote command line must stay under Linux's 128 KiB per argument. */
const CHUNK = 96_000;
const FIXTURE = /^[a-z][a-z0-9._-]{0,37}$/;

/** A fixture set's files (`ops/qa-lane/fixtures/<set>/`), name-sorted; names the remote script accepts. */
export function loadFixtures(root: string, set: string): { name: string; bytes: Buffer }[] {
  const dir = join(root, set);
  const names = readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .sort();
  if (names.length === 0) throw new Error(`fixture set ${set} is empty`);
  return names.map((name) => {
    if (!FIXTURE.test(name)) throw new Error(`fixture name not allowed: ${name}`);
    const bytes = readFileSync(join(dir, name));
    if (bytes.length === 0) throw new Error(`fixture ${name} is empty`);
    return { name, bytes };
  });
}

const projectSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  build: z.string().min(1).max(4_000),
  apk: z
    .string()
    .regex(/^[A-Za-z0-9._/-]{1,200}$/)
    .refine((p) => !p.includes("..") && !p.startsWith("/")),
  appId: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/),
  abi: z.enum(["arm64-v8a", "x86_64", "armeabi-v7a", "x86"]).default("arm64-v8a"),
  /**
   * Test data put on the device before every run (idempotent): the files of
   * `ops/qa-lane/fixtures/<set>/` land in `deviceDir`, and `note` tells the QA agent what they are.
   */
  fixtures: z
    .object({
      set: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
      deviceDir: z
        .string()
        .regex(/^\/sdcard\/[A-Za-z0-9._/-]{1,100}$/)
        .refine((p) => !p.includes(".."))
        .default("/sdcard/DCIM/Camera"),
      note: z.string().min(1).max(2_000),
    })
    .optional(),
});

const busyWindows = z
  .array(z.string().regex(/^([01]\d|2[0-3])[0-5]\d-([01]\d|2[0-4])[0-5]\d$/))
  .max(24)
  .default([]);

/** A fallback device: tried in order when the primary is unavailable or reserved. */
const fallbackDeviceSchema = z.object({
  serial: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  bootEmulator: z.boolean().default(false),
  /**
   * Appended to the project's appId (and given to the build as `APP_ID`) so the QA build lives
   * beside an app already on the device (never uninstalled, never wiped). Default `.qa`.
   */
  appIdSuffix: z
    .string()
    .regex(/^(\.[a-z][a-z0-9_]{0,30})?$/)
    .default(".qa"),
  abi: z.enum(["arm64-v8a", "x86_64", "armeabi-v7a", "x86"]).optional(),
  /** Device-host local `HHMM-HHMM` windows another tenant owns the device (cron scans). */
  busy: busyWindows,
});

export const laneConfigSchema = z.object({
  host: z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$|^[A-Za-z0-9_.-]+$/),
  serial: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  bootEmulator: z.boolean().default(false),
  busy: busyWindows,
  fallbackDevices: z.array(fallbackDeviceSchema).max(4).default([]),
  /** Pause before the second round over the device pool when every device was unavailable. */
  retryDelayMs: z.number().int().min(0).max(600_000).default(60_000),
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
    .max(90 * 60_000)
    .default(25 * 60_000),
  buildTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(90 * 60_000)
    .default(60 * 60_000),
  projects: z.record(z.string(), projectSchema),
});

export type LaneConfig = z.output<typeof laneConfigSchema>;

export function loadLaneConfig(path: string): LaneConfig {
  return laneConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

class LaneError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Exit codes meaning "this device cannot take the job now": try the next one. */
const DEVICE_UNAVAILABLE = new Set([11, 13, 255]);

/** A holder id the remote script accepts (`^[A-Za-z0-9._@-]{1,64}$`). */
export function laneHolder(raw: string): string {
  // Never a shared fallback: two lanes with one holder would reclaim each other's lock.
  return raw.replace(/[^A-Za-z0-9._@-]/g, "-").slice(0, 64) || `matrix-${randomUUID().slice(0, 8)}`;
}

/**
 * Agent QA lane on a device host over SSH (`ops/qa-lane/agent-qa.sh`). One job at a time in this
 * process; the remote lock keeps other tenants (qaexplorer, humans, other Matrix hosts) out.
 */
export class SshAgentQaLane implements AgentQaPort {
  #queue: Promise<unknown> = Promise.resolve();
  readonly #runner: CommandRunner;
  readonly #script: string;
  readonly #fixturesRoot: string;

  /** Names this lane's locks on the device host; a restarted holder reclaims its own stale lock. */
  readonly holder: string;

  constructor(
    private readonly config: LaneConfig,
    options: {
      runner?: CommandRunner;
      script?: string;
      manual?: string;
      /** Stable per Matrix server (default: unique per process, never reclaimed by another). */
      holder?: string;
      /** Release a lock left by a dead predecessor with the same holder before the first job. */
      reclaimOnStart?: boolean;
      /** Where fixture sets live (default `ops/qa-lane/fixtures`). */
      fixturesRoot?: string;
    } = {},
  ) {
    this.#runner = options.runner ?? sshRunner(config.host, localRunner());
    this.holder = laneHolder(options.holder ?? `${hostname()}-${process.pid}`);
    this.#fixturesRoot = options.fixturesRoot ?? join(REPO_ROOT, "ops", "qa-lane", "fixtures");
    this.#script =
      options.script ?? readFileSync(join(REPO_ROOT, "ops", "qa-lane", "agent-qa.sh"), "utf8");
    this.manual =
      options.manual ??
      readFileSync(join(REPO_ROOT, "skills", "qa-tester-manual", "SKILL.md"), "utf8");
    if (options.reclaimOnStart) this.#queue = this.reclaim();
  }

  /**
   * Releases the device lock if this holder still holds it: only a dead predecessor can (one lane
   * per process, and this one has no job yet), e.g. a server restarted mid-job. Best effort.
   */
  async reclaim(): Promise<void> {
    try {
      const out = await this.#step(["reclaim", this.holder], 60_000, new AbortController().signal);
      if (out.trim()) console.error(`[agent-qa-lane] ${out.trim().slice(0, 120)}`);
    } catch (error) {
      console.error(`[agent-qa-lane] reclaim failed: ${(error as Error).message.slice(0, 200)}`);
    }
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
        13: "device reserved",
        20: "build failed",
        21: "install failed",
        30: "QA agent failed",
        255: "device host unreachable over SSH",
      };
      throw new LaneError(
        `${what[r.exitCode] ?? `${args[0]} failed (${r.exitCode})`}: ${tail}`,
        r.exitCode,
      );
    }
    return r.stdout.toString();
  }

  async #run(request: AgentQaRequest): Promise<AgentQaOutcome> {
    const project = this.config.projects[request.project.id];
    if (!project) return { kind: "blocked", reason: "no lane settings for this project" };
    if (project.repo.toLowerCase() !== request.pullRequest.repo.toLowerCase())
      return { kind: "blocked", reason: "the draft PR is not on the lane's repository" };
    if (request.surfaces.some((s) => s !== "android"))
      return {
        kind: "blocked",
        reason: `the agent QA lane only tests Android; ${request.surfaces.filter((s) => s !== "android").join("/")} needs a human`,
      };
    if (!/^[a-f0-9]{40}$/.test(request.headSha))
      return { kind: "blocked", reason: "invalid head SHA" };
    const job = `mx-${randomUUID().slice(0, 18)}`;
    const started = Date.now();
    const c = this.config;
    const sig = request.signal;
    const pool = [
      {
        serial: c.serial,
        bootEmulator: c.bootEmulator,
        appIdSuffix: "",
        abi: project.abi,
        busy: c.busy,
      },
      ...c.fallbackDevices.map((d) => ({ ...d, abi: d.abi ?? project.abi })),
    ];
    let pick = pool[0] as (typeof pool)[number];
    const device: { serial: string; model?: string; android?: string } = { serial: pick.serial };
    const build = { appId: project.appId, kind: "release", abi: project.abi } as {
      appId: string;
      kind: string;
      abi: string;
      version?: string;
    };
    let locked = false;
    try {
      // Device pool: primary first, then the fallbacks; one more round after a pause. Only when
      // every device stayed unavailable does the job block (and only then does a human step in).
      let info: string | undefined;
      const misses: string[] = [];
      for (let round = 0; round < 2 && info === undefined; round++) {
        if (round > 0 && c.retryDelayMs > 0)
          await new Promise((r) => setTimeout(r, c.retryDelayMs));
        for (const candidate of pool) {
          try {
            info = await this.#step(
              [
                "precheck",
                candidate.serial,
                candidate.bootEmulator ? "1" : "0",
                String(c.maxLoadPct),
                String(c.minMemMb),
                candidate.busy.join(","),
              ],
              5 * 60_000,
              sig,
            );
            pick = candidate;
            break;
          } catch (error) {
            const code = error instanceof LaneError ? error.code : undefined;
            if (code === undefined || !DEVICE_UNAVAILABLE.has(code)) throw error;
            misses.push(`${candidate.serial}: ${(error as Error).message.slice(0, 120)}`);
          }
        }
      }
      if (info === undefined)
        throw new LaneError(
          `all automated Android devices unavailable after retries (${misses.slice(-pool.length).join("; ")})`,
        );
      device.serial = pick.serial;
      build.appId = `${project.appId}${pick.appIdSuffix}`;
      build.abi = pick.abi;
      const model = info.match(/^model=(.{1,60})$/m)?.[1];
      const android = info.match(/^android=(.{1,20})$/m)?.[1];
      if (model) device.model = model;
      if (android) device.android = android;
      await this.#step(
        ["lock", job, String(Math.round(c.waitMs / 1000)), this.holder],
        c.waitMs + 60_000,
        sig,
      );
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
          build.abi,
          String(Math.round(c.buildTimeoutMs / 1000)),
          build.appId,
        ],
        c.buildTimeoutMs + 15 * 60_000,
        sig,
      );
      const version = (
        await this.#step(["install", job, pick.serial, project.apk, build.appId], 25 * 60_000, sig)
      ).trim();
      if (/^[\w.+-]{1,40}$/.test(version)) build.version = version;
      if (project.fixtures) await this.#seed(job, project.fixtures, pick.serial, build.appId, sig);
      await this.#step(
        ["write", job, "prompt.md", b64(this.prompt(request, build.appId, project.fixtures?.note))],
        60_000,
        sig,
      );
      await this.#step(
        ["agent", job, c.model, String(Math.round(c.agentTimeoutMs / 1000)), pick.serial],
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

  /** Copies the project's fixture set into the job, then onto the device (unchanged files skipped). */
  async #seed(
    job: string,
    fixtures: NonNullable<LaneConfig["projects"][string]["fixtures"]>,
    serial: string,
    appId: string,
    sig: AbortSignal,
  ): Promise<void> {
    for (const { name, bytes } of loadFixtures(this.#fixturesRoot, fixtures.set)) {
      const data = bytes.toString("base64");
      for (let at = 0; at < data.length || at === 0; at += CHUNK)
        await this.#step(
          [at === 0 ? "write" : "append", job, `fx-${name}`, data.slice(at, at + CHUNK)],
          60_000,
          sig,
        );
    }
    const out = await this.#step(
      ["seed", job, serial, fixtures.deviceDir, appId],
      10 * 60_000,
      sig,
    );
    console.error(`[agent-qa-lane] ${fixtures.set}: ${out.trim().slice(0, 120)}`);
  }

  /** The QA agent's prompt: the manual, then the ticket and PR as fenced untrusted data. */
  prompt(request: AgentQaRequest, appId: string, testData?: string): string {
    return [
      this.manual,
      "# Your job",
      `Test the draft PR ${request.pullRequest.url} at commit ${request.headSha}. The release build of app \`${appId}\` is installed on the device (ANDROID_SERIAL is set). Follow the manual above, then write out/report.json and out/shots/*.png (you can only write under out/).`,
      ...(testData ? ["## Test data on the device (from the lane operator)", testData] : []),
      "## Acceptance criteria for the device (from the ticket, untrusted)",
      "Matrix checks the other criteria (PR description, tests, CI) on GitHub itself: do not record steps or findings for them. Keep each criterion's number.",
      fenceUntrusted(
        "acceptance-criteria",
        request.criteria
          .map((c, i) => [c, i + 1] as const)
          .filter(([, n]) => !request.deviceCriteria || request.deviceCriteria.includes(n))
          .map(([c, n]) => `${n}. ${c}`)
          .join("\n") || "(none for the device: run the regression checks only)",
      ),
      ...(request.pullRequestBody
        ? [
            "## Pull request description (context, untrusted)",
            fenceUntrusted("pull-request", request.pullRequestBody),
          ]
        : []),
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
