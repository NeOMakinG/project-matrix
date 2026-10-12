import { redact, singleLine } from "../redact.js";
import { type RawSignal, Signal } from "../signal.js";
import { normalizeGlitchtip } from "./glitchtip.js";
import type { NormalizeOptions } from "./options.js";
import { normalizeOtel } from "./otel.js";
import { normalizePosthog } from "./posthog.js";
import { normalizeSentry } from "./sentry.js";
import { normalizeUptime } from "./uptime.js";

export type { NormalizeOptions };
export { normalizeGlitchtip, normalizeOtel, normalizePosthog, normalizeSentry, normalizeUptime };

const MAX_MESSAGE = 2000;

/**
 * The single redaction point: every text field is masked here, before the signal is stored,
 * sent to an LLM or copied into a ticket. Downstream code only ever sees redacted signals.
 */
export function sanitize(signal: Signal, options: NormalizeOptions = {}): Signal {
  const r = (t: string) => redact(t, options.redact);
  const out: Signal = {
    ...signal,
    title: singleLine(r(signal.title), 300),
    message: r(signal.message).slice(0, MAX_MESSAGE),
    frames: signal.frames.slice(0, 50).map((f) => {
      const frame = { ...f, file: singleLine(r(f.file), 300) };
      if (f.function !== undefined) frame.function = singleLine(r(f.function), 200);
      return frame;
    }),
  };
  if (signal.url !== undefined) out.url = singleLine(r(signal.url), 500);
  if (signal.exceptionType !== undefined)
    out.exceptionType = singleLine(r(signal.exceptionType), 120);
  if (signal.release !== undefined) out.release = singleLine(r(signal.release), 120);
  if (signal.environment !== undefined) out.environment = singleLine(r(signal.environment), 60);
  return out;
}

/**
 * Raw envelope → validated, redacted signals. GitHub events are CI/PR signals for the loop,
 * not production errors, so they produce nothing here.
 */
export function normalize(
  raw: RawSignal,
  defaultProjectId: string,
  options: NormalizeOptions = {},
): Signal[] {
  const projectId = raw.projectId ?? defaultProjectId;
  const parsed = (() => {
    switch (raw.source) {
      case "sentry":
        return normalizeSentry(raw, projectId, options);
      case "glitchtip":
        return normalizeGlitchtip(raw, projectId, options);
      case "posthog":
        return normalizePosthog(raw, projectId);
      case "otel":
        return normalizeOtel(raw, projectId);
      case "uptime":
        return normalizeUptime(raw, projectId);
      case "github":
        return [];
    }
  })();
  return parsed.map((s) => sanitize(Signal.parse(s), options));
}
