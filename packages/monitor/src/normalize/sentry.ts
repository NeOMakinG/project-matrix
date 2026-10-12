import { hashUser } from "../redact.js";
import type { RawSignal, Signal } from "../signal.js";
import type { NormalizeOptions } from "./options.js";
import { arr, frames, isoTime, level, num, obj, shortHash, str, withOptional } from "./util.js";

const SERVER_SDK =
  /^sentry\.(javascript\.(node|bun|deno|aws-serverless|google-cloud-serverless|nestjs)|python|go|ruby|php|java(?:$|\.(?!android))|dotnet|rust|elixir|native)/;

/**
 * Sentry (and GlitchTip API events, which use the same event format).
 * Accepts integration webhooks (`data.event` / `data.issue`) and bare event objects from the API.
 */
export function normalizeSentry(
  raw: RawSignal,
  projectId: string,
  options: NormalizeOptions,
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

  // SDK name is part of the (forgeable) event, so a server claim only counts for projects
  // configured as server-only, whose DSN never ships to clients.
  const sdk = str(obj(event.sdk).name) ?? "";
  const sourceProject = str(event.project) ?? str(obj(issue.project).slug) ?? str(issue.project);
  const trusted =
    SERVER_SDK.test(sdk) &&
    sourceProject !== undefined &&
    (options.trustedServerProjects ?? []).includes(`${provider}:${sourceProject}`);
  const userId = str(obj(event.user).id) ?? str(obj(event.user).email);

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
        trust: trusted ? "server" : "client",
        userHashes: userId ? [hashUser(projectId, userId)] : [],
        reportedUsers: Math.max(0, Math.trunc(num(issue.userCount) ?? 0)),
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
