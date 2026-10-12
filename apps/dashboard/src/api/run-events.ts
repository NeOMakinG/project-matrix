import { useEffect, useState } from "react";
import { z } from "zod";
import { apiUrl, pathOf } from "./http";
import type { RunEvent } from "./view";

export type StreamState = "connecting" | "live" | "reconnecting" | "ended" | "closed";

export const MAX_BUFFERED_EVENTS = 500;
const MAX_RECONNECTS = 8;
const EVENT_KINDS = ["log", "tool", "file", "cost", "error", "done"] as const;

const runEventSchema = z.object({
  runId: z.string(),
  at: z.string(),
  kind: z.enum(EVENT_KINDS),
  message: z.string(),
});
const closeSchema = z.object({ reason: z.string() });

export function parseRunEvent(raw: string): RunEvent | null {
  try {
    const parsed = runEventSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const eventKey = (e: RunEvent) => `${e.at}|${e.kind}|${e.message}`;

type Source = Pick<EventSource, "addEventListener" | "close" | "readyState"> & {
  onerror: ((this: EventSource, ev: Event) => unknown) | null;
};
export type SourceFactory = (url: string) => Source;

const browserSource: SourceFactory | undefined =
  typeof globalThis.EventSource === "undefined"
    ? undefined
    : (url) => new EventSource(url, { withCredentials: true });

/**
 * Keeps a bounded, de-duplicated log for one run across reconnects.
 * The server sends no event ids, so duplicates after a reconnect are dropped by content.
 */
export class RunEventStream {
  private events: RunEvent[] = [];
  private keys = new Set<string>();
  private source: Source | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  state: StreamState = "connecting";

  constructor(
    private readonly runId: string,
    private readonly onChange: (events: RunEvent[], state: StreamState) => void,
    private readonly factory: SourceFactory | undefined = browserSource,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (
      fn,
      ms,
    ) => setTimeout(fn, ms),
  ) {}

  start(initial: readonly RunEvent[] = []): void {
    for (const e of initial) this.push(e, false);
    if (!this.factory) return this.setState("closed");
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.source?.close();
    this.source = null;
  }

  private connect(): void {
    if (this.stopped || !this.factory) return;
    const source = this.factory(apiUrl(pathOf("/v1/runs/{id}/events", { id: this.runId })));
    this.source = source;
    source.addEventListener("ready", () => {
      this.attempts = 0;
      this.setState("live");
    });
    for (const kind of EVENT_KINDS) {
      source.addEventListener(kind, (message) => {
        const event = parseRunEvent((message as MessageEvent<string>).data);
        if (!event || event.runId !== this.runId) return;
        this.attempts = 0;
        if (this.state !== "live") this.state = "live";
        this.push(event, true);
        if (event.kind === "done") this.finish("ended");
      });
    }
    source.addEventListener("close", (message) => {
      const parsed = closeSchema.safeParse(safeJson((message as MessageEvent<string>).data));
      const reason = parsed.success ? parsed.data.reason : "closed";
      if (reason === "overflow") this.retry();
      else this.finish("closed");
    });
    source.onerror = () => {
      if (this.stopped) return;
      // EventSource retries on its own while CONNECTING; we take over once it gives up.
      if (source.readyState === 2) this.retry();
      else this.setState("reconnecting");
    };
  }

  private retry(): void {
    this.source?.close();
    this.source = null;
    if (this.stopped) return;
    if (this.attempts >= MAX_RECONNECTS) return this.setState("closed");
    const delay = Math.min(30_000, 1000 * 2 ** this.attempts);
    this.attempts += 1;
    this.setState("reconnecting");
    this.timer = this.schedule(() => this.connect(), delay);
  }

  private finish(state: "ended" | "closed"): void {
    this.source?.close();
    this.source = null;
    this.setState(state);
  }

  private push(event: RunEvent, notify: boolean): void {
    const key = eventKey(event);
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.events = [...this.events, event];
    if (this.events.length > MAX_BUFFERED_EVENTS) {
      const dropped = this.events.slice(0, this.events.length - MAX_BUFFERED_EVENTS);
      this.events = this.events.slice(-MAX_BUFFERED_EVENTS);
      for (const e of dropped) this.keys.delete(eventKey(e));
    }
    if (notify) this.onChange(this.events, this.state);
  }

  private setState(state: StreamState): void {
    this.state = state;
    this.onChange(this.events, state);
  }

  snapshot(): RunEvent[] {
    return this.events;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function useRunEvents(runId: string, factory: SourceFactory | undefined = browserSource) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [state, setState] = useState<StreamState>("connecting");

  useEffect(() => {
    const stream = new RunEventStream(
      runId,
      (next, nextState) => {
        setEvents(next);
        setState(nextState);
      },
      factory,
    );
    setEvents([]);
    setState("connecting");
    stream.start();
    return () => stream.stop();
  }, [runId, factory]);

  return { events, state };
}
