import { describe, expect, it } from "vitest";
import {
  MAX_BUFFERED_EVENTS,
  parseRunEvent,
  RunEventStream,
  type SourceFactory,
  type StreamState,
} from "./run-events";

class FakeSource {
  readyState = 0;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, (m: { data: string }) => void>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (m: { data: string }) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.();
  }
}

function setup(runId = "r 1/x") {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const states: StreamState[] = [];
  let events: string[] = [];
  const factory: SourceFactory = (url) => {
    const s = new FakeSource(url);
    sources.push(s);
    return s as never;
  };
  const stream = new RunEventStream(
    runId,
    (e, s) => {
      events = e.map((x) => x.message);
      states.push(s);
    },
    factory,
    (fn, ms) => {
      timers.push({ fn, ms });
      return 0 as never;
    },
  );
  stream.start();
  const ev = (message: string, kind = "log", at = "2026-10-12T11:00:00Z") => ({
    runId,
    at,
    kind,
    message,
  });
  return { stream, sources, timers, states, ev, events: () => events };
}

describe("run event stream", () => {
  it("parses events and rejects malformed ones", () => {
    expect(parseRunEvent('{"runId":"r","at":"t","kind":"log","message":"ok"}')?.message).toBe("ok");
    expect(parseRunEvent("nope")).toBeNull();
    expect(parseRunEvent('{"runId":"r","at":"t","kind":"bogus","message":"x"}')).toBeNull();
  });

  it("connects to the encoded URL and goes live on ready", () => {
    const t = setup();
    expect(t.sources[0]?.url).toBe("http://matrix.test/v1/runs/r%201%2Fx/events");
    t.sources[0]?.emit("ready", { runId: "r 1/x" });
    expect(t.stream.state).toBe("live");
  });

  it("de-duplicates across reconnects and ignores other runs", () => {
    const t = setup();
    const s = t.sources[0];
    s?.emit("log", t.ev("a"));
    s?.emit("log", t.ev("a"));
    s?.emit("log", { ...t.ev("b"), runId: "other" });
    s?.fail(true);
    expect(t.stream.state).toBe("reconnecting");
    t.timers[0]?.fn();
    t.sources[1]?.emit("log", t.ev("a"));
    t.sources[1]?.emit("tool", t.ev("c", "tool"));
    expect(t.events()).toEqual(["a", "c"]);
  });

  it("backs off exponentially and gives up after repeated failures", () => {
    const t = setup();
    for (let i = 0; i < 8; i++) {
      t.sources.at(-1)?.fail(true);
      t.timers.at(-1)?.fn();
    }
    expect(t.timers.map((x) => x.ms)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    t.sources.at(-1)?.fail(true);
    expect(t.stream.state).toBe("closed");
  });

  it("lets the browser retry while CONNECTING without opening a second source", () => {
    const t = setup();
    t.sources[0]?.fail(false);
    expect(t.stream.state).toBe("reconnecting");
    expect(t.sources).toHaveLength(1);
  });

  it("ends on done, closes on revocation and reconnects after overflow", () => {
    const done = setup();
    done.sources[0]?.emit("done", done.ev("finished", "done"));
    expect(done.stream.state).toBe("ended");
    expect(done.sources[0]?.closed).toBe(true);

    const revoked = setup();
    revoked.sources[0]?.emit("close", { reason: "revoked" });
    expect(revoked.stream.state).toBe("closed");
    expect(revoked.timers).toHaveLength(0);

    const overflow = setup();
    overflow.sources[0]?.emit("close", { reason: "overflow" });
    expect(overflow.stream.state).toBe("reconnecting");
    expect(overflow.timers).toHaveLength(1);
  });

  it("keeps a bounded buffer", () => {
    const t = setup();
    for (let i = 0; i < MAX_BUFFERED_EVENTS + 25; i++) t.sources[0]?.emit("log", t.ev(`m${i}`));
    expect(t.events()).toHaveLength(MAX_BUFFERED_EVENTS);
    expect(t.events()[0]).toBe("m25");
  });

  it("reports closed when EventSource is unavailable", () => {
    const states: StreamState[] = [];
    new RunEventStream("r", (_, s) => states.push(s), undefined).start();
    expect(states).toEqual(["closed"]);
  });
});
