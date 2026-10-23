import type { Receipt } from "./ports.js";

/** Matrix itself is broken (not the code under test): blocks for a human, costs no attempt. */
export class FactoryToolingError extends Error {
  constructor(
    message: string,
    readonly receipts: Receipt[] = [],
    readonly costUsd?: number,
  ) {
    super(message);
  }
}
