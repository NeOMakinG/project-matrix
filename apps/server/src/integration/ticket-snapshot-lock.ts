import { AsyncLocalStorage } from "node:async_hooks";
import { CoreError } from "../core-port.js";
import { trackerDeadline } from "./tickets.js";

export class TicketSnapshotLock {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly context = new AsyncLocalStorage<{ projectId: string; active: boolean }>();

  async run<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (current?.active && current.projectId === projectId) return operation();
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    let release = () => {};
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => slot);
    this.queues.set(projectId, tail);
    void tail.then(() => {
      if (this.queues.get(projectId) === tail) this.queues.delete(projectId);
    });
    const scope = { projectId, active: true };
    try {
      try {
        await trackerDeadline(
          async (signal) => {
            await previous;
            signal.throwIfAborted();
          },
          undefined,
          30_000,
        );
      } catch {
        throw new CoreError(
          "tracker_unavailable",
          "Ticket snapshot lock wait timed out; retry when project tracker operations finish",
        );
      }
      return await this.context.run(scope, operation);
    } finally {
      scope.active = false;
      release();
    }
  }
}
