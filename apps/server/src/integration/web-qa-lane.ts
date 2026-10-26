import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  type AgentQaOutcome,
  type AgentQaPort,
  type AgentQaRequest,
  type ProjectConfig,
  parseAgentQaReport,
} from "@matrix/core";
import { type CommandRunner, localRunner } from "@matrix/qa";
import { z } from "zod";
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

/** The owner's own Chrome DevTools ports: the lane never binds or touches them. */
const OWNER_PORTS = new Set([9222, 9223]);
const LOCK = "/tmp/matrix-qa-web.lock";

export const webLaneSchema = z.object({
  chrome: z
    .string()
    .regex(/^\/[A-Za-z0-9._/-]+$/)
    .default("/usr/bin/google-chrome"),
  model: z
    .string()
    .regex(/^[a-z0-9.-]{3,60}$/)
    .default("claude-sonnet-5-5"),
  agentTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(90 * 60_000)
    .default(20 * 60_000),
  buildTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(60 * 60_000)
    .default(20 * 60_000),
  previewWaitMs: z
    .number()
    .int()
    .min(0)
    .max(30 * 60_000)
    .default(10 * 60_000),
  ports: z.tuple([z.number().int().min(1024), z.number().int().max(65_535)]).default([9300, 9399]),
  projects: z.record(
    z.string(),
    z.object({
      repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
      /** Preview deploy URL template, `{pr}` replaced (e.g. Netlify deploy previews). */
      previewUrl: z
        .string()
        .regex(/^https:\/\/[A-Za-z0-9.{}-]+(\/[A-Za-z0-9._~/-]*)?$/)
        .optional(),
      /** Commit-status context prefix proving the preview is built for the head SHA (`netlify/`). */
      previewStatus: z
        .string()
        .regex(/^[A-Za-z0-9 _./:-]{1,80}$/)
        .optional(),
      /** Fallback: build in a rootless podman container, then serve `dist` on 127.0.0.1. */
      build: z.string().min(1).max(2_000).optional(),
      dist: z
        .string()
        .regex(/^[A-Za-z0-9._/-]{1,120}$/)
        .refine((p) => !p.includes("..") && !p.startsWith("/"))
        .optional(),
      image: z
        .string()
        .regex(/^[A-Za-z0-9._/:-]{1,120}$/)
        .default("docker.io/library/node:22-bookworm-slim"),
      /** First page to open (path on the target). */
      start: z
        .string()
        .regex(/^\/[A-Za-z0-9._~/?=&%-]{0,200}$/)
        .default("/"),
      note: z.string().max(2_000).optional(),
    }),
  ),
});
export type WebLaneConfig = z.output<typeof webLaneSchema>;
type WebProject = WebLaneConfig["projects"][string];

class WebLaneError extends Error {}

/** Keeps a child for cleanup; a spawn failure (missing binary) must not crash the server. */
function track(kids: ChildProcess[], child: ChildProcess): void {
  child.on("error", (e) => console.error(`[web-qa-lane] ${e.message.slice(0, 200)}`));
  kids.push(child);
}

/** Static server with pretty-URL fallback (`/a/b` → `a/b.html`), bound to 127.0.0.1 only. */
const STATIC_SERVER = `import http.server, os, sys
port, root = int(sys.argv[1]), sys.argv[2]
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def send_head(self):
        p = self.translate_path(self.path)
        if not os.path.exists(p) and os.path.exists(p.rstrip("/") + ".html"):
            self.path = self.path.split("?")[0].rstrip("/") + ".html"
        return super().send_head()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
`;

const NODE = process.env.MATRIX_QA_NODE_DIR ? join(process.env.MATRIX_QA_NODE_DIR, "node") : "node";

/** Host-wide single tenant; a lock whose owning process died is reclaimed. */
function takeLock(job: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, "owner"), `${job} ${process.pid}\n`);
      return true;
    } catch {
      const pid = Number(readFileSync(join(LOCK, "owner"), "utf8").split(" ")[1] ?? "0");
      let alive = pid > 0;
      try {
        if (alive) process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) return false;
      rmSync(LOCK, { recursive: true, force: true });
    }
  }
  return false;
}

async function freePort(from: number, to: number): Promise<number> {
  for (let port = from; port <= to; port++) {
    if (OWNER_PORTS.has(port)) continue;
    const ok = await new Promise<boolean>((resolve) => {
      const srv = createServer()
        .once("error", () => resolve(false))
        .listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new WebLaneError("no free local port for the lane's Chrome");
}

async function waitFor(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (r.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

/**
 * Web driver: a dedicated headless Chrome on the Matrix host (own throwaway profile, a 127.0.0.1
 * DevTools port from the lane's range, never the owner's 9222/9223) opens the PR's preview deploy
 * (or a local build served on 127.0.0.1), a QA agent drives it with `./qa-browser`, and console
 * errors and failed requests are recorded by the lane as evidence. One job at a time.
 */
export class ChromeWebQaLane implements AgentQaPort {
  #queue: Promise<unknown> = Promise.resolve();
  readonly #runner: CommandRunner;

  constructor(
    private readonly config: WebLaneConfig,
    options: { runner?: CommandRunner } = {},
  ) {
    this.#runner = options.runner ?? localRunner();
  }

  handles(project: ProjectConfig): boolean {
    return this.config.projects[project.id] !== undefined;
  }

  run(request: AgentQaRequest): Promise<AgentQaOutcome> {
    const next = this.#queue.then(() => this.#run(request));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** The preview URL when the head SHA's preview deploy succeeded; undefined otherwise. */
  async previewFor(project: WebProject, request: AgentQaRequest): Promise<string | undefined> {
    // A preview is trusted only with a commit status proving it was built for this exact SHA.
    if (!project.previewUrl || !project.previewStatus) return undefined;
    const url = project.previewUrl.replaceAll("{pr}", String(request.pullRequest.number));
    if (project.previewStatus) {
      const end = Date.now() + this.config.previewWaitMs;
      for (;;) {
        const r = await this.#runner.run(
          [
            "gh",
            "api",
            `repos/${project.repo}/commits/${request.headSha}/statuses`,
            "--jq",
            `[.[] | select(.context | startswith(${JSON.stringify(project.previewStatus)}))][0].state // "none"`,
          ],
          { timeoutMs: 60_000 },
        );
        const state = r.exitCode === 0 ? r.stdout.toString().trim() : "error";
        if (state === "success") break;
        if (state !== "pending" || Date.now() > end) return undefined;
        await new Promise((res) => setTimeout(res, 30_000));
      }
    }
    // The preview URL is mutable: it serves this SHA only while the PR head has not moved.
    const head = await this.#runner.run(
      [
        "gh",
        "pr",
        "view",
        String(request.pullRequest.number),
        "--repo",
        project.repo,
        "--json",
        "headRefOid",
        "-q",
        ".headRefOid",
      ],
      { timeoutMs: 60_000 },
    );
    if (head.stdout.toString().trim() !== request.headSha) return undefined;
    return (await waitFor(url, 60_000)) ? url : undefined;
  }

  /** Clones the PR head, builds it in a rootless container, serves `dist` on 127.0.0.1. */
  async #localBuild(
    project: WebProject,
    request: AgentQaRequest,
    dir: string,
    kids: ChildProcess[],
  ): Promise<string> {
    if (!project.build || !project.dist)
      throw new WebLaneError("no preview deploy for this commit and no local web build configured");
    const src = join(dir, "src");
    const git = async (args: string[], cwd = src) => {
      const r = await this.#runner.run(["git", "-C", cwd, ...args], { timeoutMs: 300_000 });
      if (r.exitCode !== 0)
        throw new WebLaneError(`git ${args[0]} failed: ${r.stderr.toString().slice(-200)}`);
      return r.stdout.toString().trim();
    };
    mkdirSync(src, { recursive: true });
    await git(["init", "--quiet"]);
    await git([
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "fetch",
      "--quiet",
      "--depth=1",
      `https://github.com/${project.repo}.git`,
      `+refs/pull/${request.pullRequest.number}/head:refs/matrix/pr`,
    ]);
    if ((await git(["rev-parse", "refs/matrix/pr"])) !== request.headSha)
      throw new WebLaneError("PR head moved");
    await git(["checkout", "--quiet", "--detach", request.headSha]);
    // PR code runs only inside the container: no host mounts but the checkout, no host secrets.
    const r = await this.#runner.run(
      [
        "podman",
        "run",
        "--rm",

        "--memory=8g",
        "-v",
        `${src}:/w:Z`,
        "-w",
        "/w",
        project.image,
        "sh",
        "-c",
        `set -e\n${project.build}`,
      ],
      { timeoutMs: this.config.buildTimeoutMs },
    );
    writeFileSync(join(dir, "build.log"), `${r.stdout}\n${r.stderr}`);
    if (r.exitCode !== 0)
      throw new WebLaneError(`web build failed: ${`${r.stdout}\n${r.stderr}`.trim().slice(-500)}`);
    const dist = join(src, project.dist);
    // dist itself (or a parent inside the checkout) must not be a link out of the checkout.
    if (!realpathSync(dist).startsWith(`${realpathSync(src)}/`))
      throw new WebLaneError("the web build output resolves outside the checkout");
    if (!existsSync(join(dist, "index.html")))
      throw new WebLaneError(`web build left no ${project.dist}/index.html`);
    // The static server follows symlinks: a planted link could serve host files to the browser.
    const links = await this.#runner.run(["find", dist, "-type", "l", "-print", "-quit"], {
      timeoutMs: 60_000,
    });
    if (links.exitCode !== 0 || links.stdout.toString().trim())
      throw new WebLaneError("the web build output contains symlinks; refusing to serve it");
    const port = await freePort(this.config.ports[0], this.config.ports[1]);
    track(kids, spawn("python3", ["-c", STATIC_SERVER, String(port), dist], { stdio: "ignore" }));
    const url = `http://127.0.0.1:${port}`;
    if (!(await waitFor(url, 30_000))) throw new WebLaneError("local web server did not start");
    return url;
  }

  async #run(request: AgentQaRequest): Promise<AgentQaOutcome> {
    const c = this.config;
    const project = c.projects[request.project.id];
    if (!project) return { kind: "blocked", reason: "no web lane settings for this project" };
    if (project.repo.toLowerCase() !== request.pullRequest.repo.toLowerCase())
      return { kind: "blocked", reason: "the draft PR is not on the web lane's repository" };
    if (!/^[a-f0-9]{40}$/.test(request.headSha))
      return { kind: "blocked", reason: "invalid head SHA" };
    const started = Date.now();
    const job = newLocalJob();
    const kids: ChildProcess[] = [];
    const device = {
      serial: "chrome-headless",
      model: "Chrome (headless, dedicated profile)",
      os: "",
    };
    const build = { appId: project.repo, kind: "preview deploy" };
    let locked = false;
    try {
      locked = takeLock(job.id);
      if (!locked) throw new WebLaneError(`web lane busy (lock ${LOCK})`);
      let target = await this.previewFor(project, request);
      if (!target) {
        build.kind = "local build";
        target = await this.#localBuild(project, request, job.dir, kids);
      }
      const port = await freePort(c.ports[0], c.ports[1]);
      track(
        kids,
        spawn(
          c.chrome,
          [
            "--headless=new",
            `--user-data-dir=${join(job.dir, "profile")}`,
            "--remote-debugging-address=127.0.0.1",
            `--remote-debugging-port=${port}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-sync",
            "--window-size=1280,800",
            "about:blank",
          ],
          { stdio: "ignore", env: { PATH: "/usr/bin:/bin", HOME: join(job.dir, "home") } },
        ),
      );
      const cdp = `http://127.0.0.1:${port}`;
      if (!(await waitFor(`${cdp}/json/version`, 30_000)))
        throw new WebLaneError("the lane's Chrome did not start");
      const ver = await fetch(`${cdp}/json/version`)
        .then((r) => r.json() as Promise<{ Browser?: string }>)
        .catch(() => ({}) as { Browser?: string });
      device.os = `${(ver.Browser ?? "Chrome").replace("/", " ")}, 1280x800`;
      const events = join(job.dir, "events.jsonl");
      appendFileSync(events, "");
      const cli = join(REPO_ROOT, "packages", "qa", "bin", "qa-browser.mjs");
      const env = {
        QA_CDP: cdp,
        QA_ORIGIN: new URL(target).origin,
        QA_OUT: join(job.dir, "out"),
        QA_EVENTS: events,
      };
      track(
        kids,
        spawn(NODE, [cli, "record"], {
          stdio: "ignore",
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
        }),
      );
      // The navigation boundary is the recorder's: nothing opens before it is in place.
      const end = Date.now() + 20_000;
      while (!readFileSync(events, "utf8").includes('"kind":"ready"')) {
        if (Date.now() > end) throw new WebLaneError("the lane's browser recorder did not start");
        await new Promise((r) => setTimeout(r, 250));
      }
      const sq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
      const exports = Object.entries(env)
        .map(([k, v]) => `${k}=${sq(v)}`)
        .join(" ");
      writeTool(
        job.dir,
        "qa-browser",
        `#!/usr/bin/env bash\nexec env ${exports} ${sq(NODE)} ${sq(cli)} "$@"\n`,
      );
      const startUrl = new URL(project.start, target).href;
      const open = await this.#runner.run([join(job.dir, "qa-browser"), "open", startUrl], {
        timeoutMs: 90_000,
      });
      if (open.exitCode !== 0)
        throw new WebLaneError(`target did not load: ${open.stderr.toString().slice(-200)}`);
      await this.#runner.run([join(job.dir, "qa-browser"), "screenshot", "00-landing"], {
        timeoutMs: 60_000,
      });
      const intro = `Test the draft PR https://github.com/${project.repo}/pull/${request.pullRequest.number} at commit ${request.headSha} in a browser. The ${build.kind} is open at ${startUrl} in a dedicated headless Chrome. Drive it ONLY with \`./qa-browser\` (run \`./qa-browser help\`): snapshot, click, fill, viewport, screenshot <name> (writes out/shots/<name>.png). Check desktop (1280x800) and mobile (390x844) viewports, and run \`./qa-browser console\` and \`./qa-browser network\` after each flow: an uncaught error or failed request caused by the change is a finding. Write out/report.json (you can only write under out/).`;
      writeFileSync(
        join(job.dir, "prompt.md"),
        qaPrompt(readManual(), request, intro, project.note),
      );
      await runLocalAgent(this.#runner, job.dir, "web", c.model, c.agentTimeoutMs);
      const files = collectLocal(job.dir);
      const report = parseAgentQaReport(files.get("report.json")?.toString("utf8") ?? "");
      const evidence = summarizeEvents(readFileSync(events, "utf8"));
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
        build: { ...build, appId: new URL(target).host },
        durationMs: Date.now() - started,
        ...(evidence.length ? { evidence } : {}),
      };
    } catch (error) {
      return { kind: "blocked", reason: (error as Error).message.slice(0, 600), device, build };
    } finally {
      for (const k of kids.reverse()) k.kill("SIGKILL");
      if (locked) rmSync(LOCK, { recursive: true, force: true });
      removeLocalJob(job.dir);
    }
  }
}

/** Distinct console/page errors and failed requests (counted), capped for the report. */
export function summarizeEvents(jsonl: string): string[] {
  const counts = new Map<string, number>();
  for (const line of jsonl.split("\n")) {
    try {
      const e = JSON.parse(line) as { kind?: string; text?: string };
      if (!e.kind || !e.text || e.kind === "ready") continue;
      const key = `${e.kind}: ${e.text.slice(0, 200)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } catch {
      // partial line
    }
  }
  return [...counts].slice(0, 30).map(([k, n]) => (n > 1 ? `${k} (x${n})` : k));
}
