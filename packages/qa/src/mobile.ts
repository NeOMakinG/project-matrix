import type { Receipt } from "@matrix/core";

export type MobilePlatform = "ios" | "android";

/**
 * Mobile QA surface. Backed by agent-device (miniforum Android phone / emulator) or Orca's emulator
 * commands. Implementations land with the Expo stack pack; the interface is fixed now so QA phases
 * can be written against it.
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

export class NotImplementedMobileDriver implements MobileDriver {
  constructor(
    readonly id: "agent-device" | "orca-emulator",
    readonly platform: MobilePlatform,
  ) {}
  #fail(): never {
    throw new Error(
      `${this.id} mobile driver is not implemented yet (planned with the Expo stack pack)`,
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
