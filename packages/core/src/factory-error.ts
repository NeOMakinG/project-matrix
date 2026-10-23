import type { Receipt } from "./ports.js";

/** Matrix itself is broken (not the code under test): blocks for a human, costs no attempt. */
export class FactoryToolingError extends Error {
  /**
   * A cause the thrower vouches is Matrix-authored and safe to show operators (never model output
   * or holdout text). Without it, private phases (QA) publish only a generic summary.
   */
  operatorCause?: string;
  constructor(
    message: string,
    readonly receipts: Receipt[] = [],
    readonly costUsd?: number,
  ) {
    super(message);
  }
}

/**
 * A FactoryToolingError whose message is a fixed Matrix-authored string, vouched safe for
 * operators. Never pass model output, holdout text, probe source or an inner error's message.
 */
export function vouchedToolingError(
  message: string,
  receipts: Receipt[] = [],
  costUsd?: number,
): FactoryToolingError {
  const error = new FactoryToolingError(message, receipts, costUsd);
  error.operatorCause = message;
  return error;
}
