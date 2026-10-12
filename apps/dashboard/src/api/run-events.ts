import { useEffect, useState } from "react";
import { apiUrl } from "./client";
import { type RunEvent, runEventSchema } from "./schemas";

export type StreamState = "connecting" | "live" | "closed";

type EventSourceCtor = new (
  url: string,
) => Pick<EventSource, "addEventListener" | "close" | "onopen" | "onerror">;

export function parseRunEvent(raw: string): RunEvent | null {
  try {
    const parsed = runEventSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function subscribeRunEvents(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onState: (state: StreamState) => void,
  Source: EventSourceCtor | undefined = globalThis.EventSource,
): () => void {
  if (!Source) {
    onState("closed");
    return () => {};
  }
  const source = new Source(apiUrl(`/runs/${runId}/events`));
  source.onopen = () => onState("live");
  source.onerror = () => onState("closed");
  source.addEventListener("message", (message: MessageEvent<string>) => {
    const event = parseRunEvent(message.data);
    if (event) onEvent(event);
  });
  return () => source.close();
}

export function useRunEvents(runId: string, initial: RunEvent[]) {
  const [events, setEvents] = useState<RunEvent[]>(initial);
  const [state, setState] = useState<StreamState>("connecting");

  useEffect(() => {
    setEvents(initial);
    return subscribeRunEvents(runId, (event) => setEvents((prev) => [...prev, event]), setState);
  }, [runId, initial]);

  return { events, state };
}
