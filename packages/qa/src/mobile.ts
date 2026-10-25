import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Receipt } from "@matrix/core";
import type { CommandRunner } from "./mobile-runner.js";

export type MobilePlatform = "ios" | "android";

/**
 * Mobile QA surface. Android: `AdbMobileDriver` over a `CommandRunner` (local adb, or adb on the
 * device host over SSH). iOS is not implemented yet.
 */
export interface MobileDriver {
  readonly id: string;
  readonly platform: MobilePlatform;
  install(appPath: string): Promise<void>;
  launch(appId: string): Promise<void>;
  tap(target: { text?: string; id?: string; x?: number; y?: number }): Promise<void>;
  type(text: string): Promise<void>;
  screenshot(path: string): Promise<Receipt>;
  startRecording(path: string): Promise<void>;
  stopRecording(): Promise<Receipt | undefined>;
  /** Accessibility tree for agent reasoning. */
  uiTree(): Promise<unknown>;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Device-side shell word (adb shell joins argv with spaces into one device shell command). */
function deviceQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Center of the first node whose text / content-desc or resource-id matches. */
export function findNodeCenter(
  xml: string,
  target: { text?: string; id?: string },
): { x: number; y: number } | undefined {
  for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
    const node = m[0];
    const attr = (name: string) => {
      const a = node.match(new RegExp(`\\b${name}="([^"]*)"`));
      return a?.[1] === undefined ? undefined : decodeXml(a[1]);
    };
    const hit =
      (target.id !== undefined && attr("resource-id") === target.id) ||
      (target.text !== undefined &&
        (attr("text") === target.text || attr("content-desc") === target.text));
    if (!hit) continue;
    const b = attr("bounds")?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number) as [number, number, number, number];
    return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
  }
  return undefined;
}

/**
 * Android over adb. Lessons from qaexplorer: `uiautomator dump` sometimes returns a stub (retry
 * until it has `<node`), each dump uses its own file, cold starts need a readiness wait.
 */
export class AdbMobileDriver implements MobileDriver {
  readonly id = "adb";
  readonly platform = "android" as const;
  #dumps = 0;
  #recording: Promise<unknown> | undefined;
  #recordPath: string | undefined;

  constructor(
    private readonly runner: CommandRunner,
    readonly serial: string,
    private readonly adb = "adb",
  ) {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(serial)) throw new Error("invalid device serial");
  }

  async #adb(args: string[], timeoutMs = 60_000) {
    const r = await this.runner.run([this.adb, "-s", this.serial, ...args], { timeoutMs });
    if (r.exitCode !== 0)
      throw new Error(`adb ${args[0]} failed (${r.exitCode}): ${r.stderr.trim().slice(-300)}`);
    return r.stdout;
  }

  async #shell(words: string[], timeoutMs?: number): Promise<string> {
    return (await this.#adb(["shell", words.map(deviceQuote).join(" ")], timeoutMs)).toString();
  }

  async state(): Promise<string> {
    const r = await this.runner.run([this.adb, "-s", this.serial, "get-state"], {
      timeoutMs: 15_000,
    });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "missing";
  }

  async install(appPath: string): Promise<void> {
    await this.#adb(["install", "-r", "-g", appPath], 300_000);
  }

  async launch(appId: string): Promise<void> {
    if (!/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(appId)) throw new Error("invalid app id");
    await this.#shell(["am", "force-stop", appId]);
    await this.#shell(["monkey", "-p", appId, "-c", "android.intent.category.LAUNCHER", "1"]);
    for (let i = 0; i < 30; i++) {
      await sleep(1_000);
      const top = await this.#shell(["dumpsys", "activity", "activities"]).catch(() => "");
      const line = top.split("\n").find((l) => /topResumedActivity|mResumedActivity/.test(l));
      if (line?.includes(`${appId}/`)) return;
    }
    throw new Error(`${appId} did not reach the foreground within 30 s`);
  }

  async tap(target: { text?: string; id?: string; x?: number; y?: number }): Promise<void> {
    let point =
      target.x !== undefined && target.y !== undefined ? { x: target.x, y: target.y } : undefined;
    if (!point) {
      point = findNodeCenter(String(await this.uiTree()), target);
      if (!point) throw new Error("tap target not found on screen");
    }
    await this.#shell(["input", "tap", String(Math.round(point.x)), String(Math.round(point.y))]);
  }

  async type(text: string): Promise<void> {
    // `input text` treats spaces as separators: %s is its escape for a space.
    await this.#shell(["input", "text", text.replace(/ /g, "%s")]);
  }

  async screenshot(path: string): Promise<Receipt> {
    const bytes = await this.#adb(["exec-out", "screencap", "-p"]);
    if (!bytes.subarray(0, 8).equals(PNG)) throw new Error("screencap did not return a PNG");
    await writeFile(path, bytes);
    return {
      kind: "screenshot",
      ok: true,
      summary: `android screenshot (${this.serial})`,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async startRecording(path: string): Promise<void> {
    if (this.#recording) throw new Error("already recording");
    this.#recordPath = path;
    this.#recording = this.#shell(
      ["screenrecord", "--time-limit", "180", "/sdcard/matrix-record.mp4"],
      200_000,
    ).catch(() => undefined);
    await sleep(500);
  }

  async stopRecording(): Promise<Receipt | undefined> {
    if (!this.#recording || !this.#recordPath) return undefined;
    await this.#shell(["pkill", "-INT", "screenrecord"]).catch(() => undefined);
    await this.#recording;
    this.#recording = undefined;
    await sleep(1_000);
    const bytes = await this.#adb(["exec-out", "cat", "/sdcard/matrix-record.mp4"], 120_000);
    await writeFile(this.#recordPath, bytes);
    return {
      kind: "video",
      ok: bytes.length > 0,
      summary: `android screen recording (${this.serial})`,
      path: this.#recordPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async uiTree(): Promise<unknown> {
    const file = `/sdcard/matrix-dump-${process.pid}-${this.#dumps++}.xml`;
    for (let i = 0; i < 5; i++) {
      await this.#shell(["uiautomator", "dump", file]).catch(() => "");
      const xml = await this.#shell(["cat", file]).catch(() => "");
      if (xml.includes("<node") && xml.length > 500) {
        await this.#shell(["rm", "-f", file]).catch(() => "");
        return xml;
      }
      await sleep(700);
    }
    throw new Error("uiautomator dump kept returning an empty tree");
  }
}

/** iOS is not implemented yet. */
export class NotImplementedMobileDriver implements MobileDriver {
  constructor(
    readonly id: "agent-device" | "orca-emulator",
    readonly platform: MobilePlatform,
  ) {}
  #fail(): never {
    throw new Error(
      `${this.id} mobile driver is not implemented yet (Android: use AdbMobileDriver)`,
    );
  }
  async install(): Promise<void> {
    this.#fail();
  }
  async launch(): Promise<void> {
    this.#fail();
  }
  async tap(): Promise<void> {
    this.#fail();
  }
  async type(): Promise<void> {
    this.#fail();
  }
  async screenshot(): Promise<Receipt> {
    this.#fail();
  }
  async startRecording(): Promise<void> {
    this.#fail();
  }
  async stopRecording(): Promise<Receipt | undefined> {
    this.#fail();
  }
  async uiTree(): Promise<unknown> {
    this.#fail();
  }
}
