import type { EventBus, TrackerFailedEvent } from "@matrix/core";
import { singleLine } from "@matrix/monitor";

export interface TrackerFailure {
  ticketId?: string;
  operation: string;
  message: string;
  at: string;
}

/**
 * Keeps the latest tracker write failures per project (bounded) and logs each one as a
 * structured warning, so an outage shows up in the API/dashboard instead of being swallowed.
 */
export class TrackerHealth {
  readonly #failures = new Map<string, TrackerFailure[]>();
  #unsubscribe: (() => void) | undefined;

  constructor(
    private readonly bus: EventBus,
    private readonly log: (message: string) => void,
    private readonly perProject = 50,
    private readonly maxProjects = 500,
  ) {}

  start(): void {
    this.#unsubscribe ??= this.bus.subscribe((event) => {
      if (event.type === "tracker.failed") this.record(event);
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  record(event: TrackerFailedEvent): void {
    const failure: TrackerFailure = {
      ...(event.ticketId ? { ticketId: singleLine(event.ticketId, 80) } : {}),
      operation: singleLine(event.operation, 40),
      message: singleLine(event.message, 500),
      at: event.at,
    };
    this.log(
      JSON.stringify({
        level: "warn",
        event: "tracker.failed",
        projectId: event.projectId,
        ...failure,
      }),
    );
    const list = this.#failures.get(event.projectId) ?? [];
    this.#failures.delete(event.projectId);
    this.#failures.set(event.projectId, [...list, failure].slice(-this.perProject));
    if (this.#failures.size > this.maxProjects)
      this.#failures.delete(this.#failures.keys().next().value as string);
  }

  /** Newest first. */
  failures(projectId: string): TrackerFailure[] {
    return [...(this.#failures.get(projectId) ?? [])].reverse();
  }
}
