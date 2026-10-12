import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Receipt } from "@matrix/core";
import { hostExecutor, type LineExecutor, runToCompletion } from "@matrix/sandbox";
import { fileReceipt, slug } from "./receipts.js";

/** What a QA scenario can do in a browser. Implemented by Playwright and agent-browser drivers. */
export interface BrowserDriver {
  readonly id: string;
  start(options: { outDir: string; recordVideo: boolean }): Promise<void>;
  open(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  text(selector: string): Promise<string>;
  waitFor(selector: string, timeoutMs?: number): Promise<void>;
  screenshot(path: string): Promise<void>;
  /** Closes the browser; returns the recorded video path when recording. */
  stop(): Promise<string | undefined>;
}

export type ScenarioStep =
  | { do: "open"; url: string }
  | { do: "click"; selector: string }
  | { do: "fill"; selector: string; value: string }
  | { do: "waitFor"; selector: string; timeoutMs?: number }
  | { do: "expectText"; selector: string; includes: string }
  | { do: "screenshot"; name: string };

export interface Scenario {
  name: string;
  steps: ScenarioStep[];
  recordVideo?: boolean;
}

export interface ScenarioResult {
  ok: boolean;
  failedStep?: number;
  error?: string;
  receipts: Receipt[];
}

/** Runs a scripted scenario; screenshots and the video become receipts. Always screenshots on failure. */
export async function runScenario(
  driver: BrowserDriver,
  scenario: Scenario,
  outDir: string,
): Promise<ScenarioResult> {
  const dir = join(outDir, slug(scenario.name));
  await mkdir(dir, { recursive: true });
  const receipts: Receipt[] = [];
  let failedStep: number | undefined;
  let error: string | undefined;
  await driver.start({ outDir: dir, recordVideo: scenario.recordVideo ?? true });
  try {
    for (const [index, step] of scenario.steps.entries()) {
      try {
        if (step.do === "open") await driver.open(step.url);
        else if (step.do === "click") await driver.click(step.selector);
        else if (step.do === "fill") await driver.fill(step.selector, step.value);
        else if (step.do === "waitFor") await driver.waitFor(step.selector, step.timeoutMs);
        else if (step.do === "expectText") {
          const text = await driver.text(step.selector);
          if (!text.includes(step.includes))
            throw new Error(
              `${step.selector} text ${JSON.stringify(text.slice(0, 200))} lacks ${JSON.stringify(step.includes)}`,
            );
        } else {
          const path = join(dir, `${String(index).padStart(2, "0")}-${slug(step.name)}.png`);
          await driver.screenshot(path);
          receipts.push(await fileReceipt("screenshot", path, `${scenario.name}: ${step.name}`));
        }
      } catch (e) {
        failedStep = index;
        error = `step ${index} (${step.do}) failed: ${e instanceof Error ? e.message : String(e)}`;
        const path = join(dir, `failure-step-${index}.png`);
        try {
          await driver.screenshot(path);
          receipts.push(
            await fileReceipt(
              "screenshot",
              path,
              `${scenario.name}: failure at step ${index}`,
              false,
            ),
          );
        } catch {}
        break;
      }
    }
  } finally {
    const video = await driver.stop().catch(() => undefined);
    if (video)
      receipts.push(
        await fileReceipt("video", video, `${scenario.name} recording`, failedStep === undefined),
      );
  }
  return {
    ok: failedStep === undefined,
    receipts,
    ...(failedStep !== undefined ? { failedStep } : {}),
    ...(error ? { error } : {}),
  };
}

/** Drives the `agent-browser` CLI in an isolated session. */
export class AgentBrowserDriver implements BrowserDriver {
  readonly id = "agent-browser";
  readonly #session: string;
  readonly #binary: string;
  readonly #executor: LineExecutor;
  #videoPath: string | undefined;

  constructor(options: { session?: string; binary?: string; executor?: LineExecutor } = {}) {
    this.#session = options.session ?? `matrix-qa-${process.pid}-${Date.now()}`;
    this.#binary = options.binary ?? "agent-browser";
    this.#executor = options.executor ?? hostExecutor;
  }

  async #run(args: string[]): Promise<string> {
    const result = await runToCompletion(this.#executor, {
      cmd: [this.#binary, "--session", this.#session, ...args],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0)
      throw new Error(
        `agent-browser ${args[0]} failed: ${result.stderrTail.trim().slice(-300) || result.stdout.slice(-300)}`,
      );
    return result.stdout;
  }

  async start(options: { outDir: string; recordVideo: boolean }): Promise<void> {
    if (options.recordVideo) {
      this.#videoPath = join(options.outDir, "recording.webm");
      await this.#run(["record", "start", this.#videoPath]);
    }
  }
  async open(url: string) {
    await this.#run(["open", url]);
  }
  async click(selector: string) {
    await this.#run(["click", selector]);
  }
  async fill(selector: string, value: string) {
    await this.#run(["fill", selector, value]);
  }
  async text(selector: string) {
    return (await this.#run(["get", "text", selector])).trim();
  }
  async waitFor(selector: string, timeoutMs?: number) {
    await this.#run(["wait", selector, ...(timeoutMs ? ["--timeout", String(timeoutMs)] : [])]);
  }
  async screenshot(path: string) {
    await this.#run(["screenshot", path]);
  }
  async stop(): Promise<string | undefined> {
    if (this.#videoPath) await this.#run(["record", "stop"]).catch(() => undefined);
    await this.#run(["close"]).catch(() => undefined);
    return this.#videoPath;
  }
}
