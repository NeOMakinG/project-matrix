import { describe, expect, it, vi } from "vitest";
import { parseRunEvent, type StreamState, subscribeRunEvents } from "./run-events";

class FakeSource {
  static last: FakeSource | undefined;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listener: ((m: { data: string }) => void) | undefined;
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(_type: string, fn: (m: { data: string }) => void) {
    this.listener = fn;
  }
  close() {
    this.closed = true;
  }
  emit(data: string) {
    this.listener?.({ data });
  }
}

describe("run events stream", () => {
  it("parses valid events and rejects malformed ones", () => {
    expect(parseRunEvent('{"at":"2026-10-12T11:00:00Z","phase":"qa","message":"ok"}')).toEqual({
      at: "2026-10-12T11:00:00Z",
      phase: "qa",
      message: "ok",
    });
    expect(parseRunEvent("not json")).toBeNull();
    expect(parseRunEvent('{"phase":"nope"}')).toBeNull();
  });

  it("subscribes, forwards valid events, tracks state and closes", () => {
    const events: string[] = [];
    const states: StreamState[] = [];
    const stop = subscribeRunEvents(
      "r_1",
      (e) => events.push(e.message),
      (s) => states.push(s),
      FakeSource as never,
    );
    const source = FakeSource.last;
    expect(source?.url).toBe("http://matrix.test/api/runs/r_1/events");
    source?.onopen?.();
    source?.emit('{"at":"2026-10-12T11:00:00Z","phase":"review","message":"P1 0"}');
    source?.emit("garbage");
    source?.onerror?.();
    stop();
    expect(events).toEqual(["P1 0"]);
    expect(states).toEqual(["live", "closed"]);
    expect(source?.closed).toBe(true);
  });

  it("reports closed when EventSource is unavailable", () => {
    const onState = vi.fn();
    subscribeRunEvents("r_1", () => {}, onState, undefined);
    expect(onState).toHaveBeenCalledWith("closed");
  });
});
