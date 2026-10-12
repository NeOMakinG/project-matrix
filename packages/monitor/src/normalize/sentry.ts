import type { RawSignal, Signal } from "../signal.js";
import { arr, frames, isoTime, level, num, obj, shortHash, str, withOptional } from "./util.js";

/**
 * Sentry (and GlitchTip API events, which use the same event format).
 * Accepts integration webhooks (`data.event` / `data.issue`) and bare event objects from the API.
 */
export function normalizeSentry(
  raw: RawSignal,
  projectId: string,
  provider: "sentry" | "glitchtip" = "sentry",
): Signal[] {
  const payload = obj(raw.payload);
  const data = obj(payload.data);
  const event = Object.keys(obj(data.event)).length > 0 ? obj(data.event) : payload;
  const issue = obj(data.issue);

  const exception = arr(obj(event.exception).values);
  const last = obj(exception[exception.length - 1]);
  const exceptionType = str(last.type);
  const exceptionValue = str(last.value);
  const title =
    str(event.title) ?? str(issue.title) ?? raw.title ?? exceptionType ?? "Sentry event";
  const issueId = str(event.issue_id) ?? str(issue.id) ?? raw.fingerprint;
  const eventId = str(event.event_id) ?? str(event.id);
  const tags = arr(event.tags);
  const tag = (key: string) => {
    for (const t of tags) {
      if (Array.isArray(t) && t[0] === key) return str(t[1]);
      const o = obj(t);
      if (o.key === key) return str(o.value);
    }
    return undefined;
  };

  return [
    withOptional<Signal>(
      {
        id: `${provider}:${eventId ?? shortHash(title, raw.receivedAt)}`,
        provider,
        projectId,
        kind: "error",
        title,
        message: exceptionValue ?? str(event.message) ?? str(issue.culprit) ?? "",
        level: level(event.level ?? issue.level),
        occurredAt: isoTime(event.timestamp ?? event.datetime ?? issue.lastSeen, raw.receivedAt),
        frames: frames(obj(last.stacktrace).frames),
        users: num(issue.userCount) ?? (obj(event.user).id ? 1 : 0),
        count: Math.max(1, Math.trunc(num(issue.count) ?? 1)),
      },
      {
        release: str(event.release) ?? tag("release"),
        environment: str(event.environment) ?? tag("environment"),
        exceptionType,
        providerFingerprint: issueId,
        url: str(event.web_url) ?? str(issue.permalink),
      },
    ),
  ];
}
