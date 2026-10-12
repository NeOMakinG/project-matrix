import { useEffect, useState } from "react";
import { z } from "zod";
import { apiUrl, pathOf } from "./http";
import type { RunEvent } from "./view";

export type StreamState = "connecting" | "live" | "reconnecting" | "ended" | "closed";

export const MAX_BUFFERED_EVENTS = 500;
/** Total UTF-8 size kept in memory for one run's log. */
export const MAX_BUFFERED_BYTES = 256 * 1024;
/** A single message longer than this is truncated before it is buffered. */
export const MAX_MESSAGE_BYTES = 8 * 1024;

const encoder = new TextEncoder();
const byteSize = (text: string) => encoder.encode(text).length;

export function truncateBytes(text: string, max = MAX_MESSAGE_BYTES): string {
  if (byteSize(text) <= max) return text;
  let end = Math.min(text.length, max);
  while (end > 0 && byteSize(text.slice(0, end)) > max - 3) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Frames bigger than this are not even parsed; a placeholder line is logged instead. */
export const MAX_FRAME_CHARS = 1024 * 1024;

const eventBytes = (e: RunEvent) => byteSize(e.message) + e.at.length + e.kind.length;
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
  private bytes = 0;
  private lastEventId: string | null = null;
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
    // The browser sends Last-Event-ID on its own retries; a fresh source needs the query parameter.
    const base = apiUrl(pathOf("/v1/runs/{id}/events", { id: this.runId }));
    const url = this.lastEventId
      ? `${base}?lastEventId=${encodeURIComponent(this.lastEventId)}`
      : base;
    const source = this.factory(url);
    this.source = source;
    source.addEventListener("ready", () => {
      this.attempts = 0;
      this.setState("live");
    });
    for (const kind of EVENT_KINDS) {
      source.addEventListener(kind, (message) => {
        const raw = message as MessageEvent<string>;
        if (raw.lastEventId) this.lastEventId = raw.lastEventId;
        const data = typeof raw.data === "string" ? raw.data : "";
        if (!data) return;
        const event =
          data.length > MAX_FRAME_CHARS
            ? {
                runId: this.runId,
                at: new Date().toISOString(),
                kind: "error" as const,
                message: `event ${raw.lastEventId || ""} dropped: ${data.length} characters is over the limit`,
              }
            : parseRunEvent(data);
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

  private push(incoming: RunEvent, notify: boolean): void {
    // De-duplicate on the original content, store the truncated message.
    const key = eventKey(incoming);
    if (this.keys.has(key)) return;
    this.keys.add(key);
    const event = { ...incoming, message: truncateBytes(incoming.message) };
    this.events = [...this.events, event];
    this.eventKeys.push(key);
    this.bytes += eventBytes(event);
    let drop = 0;
    while (
      drop < this.events.length - 1 &&
      (this.events.length - drop > MAX_BUFFERED_EVENTS || this.bytes > MAX_BUFFERED_BYTES)
    ) {
      this.bytes -= eventBytes(this.events[drop] as RunEvent);
      drop += 1;
    }
    if (drop) {
      this.events = this.events.slice(drop);
      // Keep the keys of recently dropped events so a reconnect replay can't re-add them.
      this.droppedKeys.push(...this.eventKeys.splice(0, drop));
      const excess = this.droppedKeys.length - MAX_BUFFERED_EVENTS;
      if (excess > 0) for (const k of this.droppedKeys.splice(0, excess)) this.keys.delete(k);
    }
    if (notify) this.onChange(this.events, this.state);
  }

  private eventKeys: string[] = [];
  private droppedKeys: string[] = [];

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
