import { type RawSignal, Signal } from "../signal.js";
import { normalizeGlitchtip } from "./glitchtip.js";
import { normalizeOtel } from "./otel.js";
import { normalizePosthog } from "./posthog.js";
import { normalizeSentry } from "./sentry.js";
import { normalizeUptime } from "./uptime.js";

export { normalizeGlitchtip, normalizeOtel, normalizePosthog, normalizeSentry, normalizeUptime };

/**
 * Raw envelope → validated signals. GitHub events are CI/PR signals for the loop,
 * not production errors, so they produce nothing here.
 */
export function normalize(raw: RawSignal, defaultProjectId: string): Signal[] {
  const projectId = raw.projectId ?? defaultProjectId;
  const parsed = (() => {
    switch (raw.source) {
      case "sentry":
        return normalizeSentry(raw, projectId);
      case "glitchtip":
        return normalizeGlitchtip(raw, projectId);
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
  return parsed.map((s) => Signal.parse(s));
}
