import { hashUser } from "../redact.js";
import type { RawSignal, Signal } from "../signal.js";
import { arr, frames, isoTime, level, obj, shortHash, str, withOptional } from "./util.js";

/**
 * PostHog error tracking `$exception` events, as sent by a webhook destination
 * (`{ event: {...}, person, project }`) or returned by the events/query API (bare event).
 */
export function normalizePosthog(raw: RawSignal, projectId: string): Signal[] {
  const payload = obj(raw.payload);
  const event = Object.keys(obj(payload.event)).length > 0 ? obj(payload.event) : payload;
  const props = obj(event.properties);
  const list = arr(props.$exception_list);
  const exc = obj(list[0]);
  const exceptionType = str(exc.type) ?? str(props.$exception_type);
  const message = str(exc.value) ?? str(props.$exception_message) ?? "";
  const title = exceptionType ? `${exceptionType}: ${message}`.trim() : raw.title;
  const uuid = str(event.uuid);
  const distinctId = str(event.distinct_id);

  return [
    withOptional<Signal>(
      {
        id: `posthog:${uuid ?? shortHash(title, raw.receivedAt)}`,
        provider: "posthog",
        projectId,
        kind: "error",
        title: title || "PostHog exception",
        message,
        level: level(props.$exception_level),
        occurredAt: isoTime(event.timestamp, raw.receivedAt),
        frames: frames(obj(exc.stacktrace).frames),
        // Anyone holding the public capture key can send these events.
        trust: "client",
        userHashes: distinctId ? [hashUser(projectId, distinctId)] : [],
        reportedUsers: 0,
        count: 1,
      },
      {
        release: str(props.$app_version) ?? str(props.release),
        environment: str(props.environment) ?? str(props.$environment),
        exceptionType,
        providerFingerprint: str(props.$exception_fingerprint) ?? str(props.$exception_issue_id),
        url: str(props.$current_url) ?? str(event.url),
      },
    ),
  ];
}
