import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserDriver } from "./browser.js";

interface PwLocator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  innerText(): Promise<string>;
  waitFor(options?: { timeout?: number }): Promise<void>;
  first(): PwLocator;
}
interface PwPage {
  goto(url: string): Promise<unknown>;
  locator(selector: string): PwLocator;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  video(): { path(): Promise<string> } | null;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(options?: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwChromium {
  launch(options?: { headless?: boolean; executablePath?: string }): Promise<PwBrowser>;
  connectOverCDP(endpoint: string): Promise<PwBrowser>;
}

export interface PlaywrightDriverOptions {
  executablePath?: string;
  /** Attach to an existing browser (e.g. an Orca-managed one) instead of launching. */
  cdpUrl?: string;
  viewport?: { width: number; height: number };
  headless?: boolean;
}

async function loadChromium(): Promise<PwChromium> {
  const moduleName = "playwright-core";
  const mod = (await import(moduleName)) as { chromium: PwChromium };
  return mod.chromium;
}

/** Playwright-backed driver; records a WebM video of the whole scenario. */
export class PlaywrightDriver implements BrowserDriver {
  readonly id = "playwright";
  readonly #o: PlaywrightDriverOptions;
  #browser: PwBrowser | undefined;
  #context: PwContext | undefined;
  #page: PwPage | undefined;
  #videoTarget: string | undefined;

  constructor(options: PlaywrightDriverOptions = {}) {
    this.#o = options;
  }

  #p(): PwPage {
    if (!this.#page) throw new Error("driver not started");
    return this.#page;
  }

  async start(options: { outDir: string; recordVideo: boolean }): Promise<void> {
    const chromium = await loadChromium();
    this.#browser = this.#o.cdpUrl
      ? await chromium.connectOverCDP(this.#o.cdpUrl)
      : await chromium.launch({
          headless: this.#o.headless ?? true,
          ...(this.#o.executablePath ? { executablePath: this.#o.executablePath } : {}),
        });
    const viewport = this.#o.viewport ?? { width: 1440, height: 900 };
    this.#context = await this.#browser.newContext({
      viewport,
      ...(options.recordVideo ? { recordVideo: { dir: options.outDir, size: viewport } } : {}),
    });
    this.#videoTarget = options.recordVideo ? join(options.outDir, "recording.webm") : undefined;
    this.#page = await this.#context.newPage();
  }
  async open(url: string) {
    await this.#p().goto(url);
  }
  async click(selector: string) {
    await this.#p().locator(selector).first().click();
  }
  async fill(selector: string, value: string) {
    await this.#p().locator(selector).first().fill(value);
  }
  async text(selector: string) {
    return this.#p().locator(selector).first().innerText();
  }
  async waitFor(selector: string, timeoutMs?: number) {
    await this.#p()
      .locator(selector)
      .first()
      .waitFor(timeoutMs !== undefined ? { timeout: timeoutMs } : {});
  }
  async screenshot(path: string) {
    await this.#p().screenshot({ path, fullPage: true });
  }
  async stop(): Promise<string | undefined> {
    const video = this.#page?.video();
    await this.#context?.close();
    await this.#browser?.close();
    if (!video || !this.#videoTarget) return undefined;
    const recorded = await video.path();
    await rename(recorded, this.#videoTarget);
    return this.#videoTarget;
  }
}
