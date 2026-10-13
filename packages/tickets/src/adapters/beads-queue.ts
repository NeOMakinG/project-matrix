import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const queues = new Map<string, Promise<void>>();

export class BeadsQueueTimeoutError extends Error {
  constructor() {
    super("Beads tracker queue wait timed out; retry when repository operations finish");
    this.name = "BeadsQueueTimeoutError";
  }
}

export async function withBeadsQueue<T>(
  cwd: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  waitMs = 30_000,
): Promise<T> {
  signal?.throwIfAborted();
  let key: string;
  try {
    key = realpathSync(cwd);
  } catch {
    key = resolve(cwd);
  }
  const previous = queues.get(key) ?? Promise.resolve();
  let release = () => {};
  const slot = new Promise<void>((resolveSlot) => {
    release = resolveSlot;
  });
  const tail = previous.then(() => slot);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    await Promise.race([
      previous,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal?.reason ?? new Error("Beads queue cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new BeadsQueueTimeoutError()), waitMs);
      }),
    ]);
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    signal?.throwIfAborted();
    return await operation();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    release();
  }
}
