import type { LineExecutor } from "./process.js";

const readOnlyExecutors = new WeakSet<LineExecutor>();

export function registerReadOnlyExecutor(executor: LineExecutor): LineExecutor {
  readOnlyExecutors.add(executor);
  return executor;
}

export function isReadOnlyExecutor(executor: LineExecutor): boolean {
  return readOnlyExecutors.has(executor);
}
