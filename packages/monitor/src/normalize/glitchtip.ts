import type { RawSignal, Signal } from "../signal.js";
import type { NormalizeOptions } from "./options.js";
import { normalizeSentry } from "./sentry.js";
import { arr, obj, shortHash, str, withOptional } from "./util.js";

/**
 * GlitchTip alert webhooks are Slack-compatible (`attachments[].fields`).
 * Events pulled from the GlitchTip API use the Sentry event format.
 */
export function normalizeGlitchtip(
  raw: RawSignal,
  projectId: string,
  options: NormalizeOptions,
): Signal[] {
  const payload = obj(raw.payload);
  const attachments = arr(payload.attachments);
  if (attachments.length === 0) return normalizeSentry(raw, projectId, options, "glitchtip");

  return attachments.map((a) => {
    const att = obj(a);
    const field = (name: string) => {
      for (const f of arr(att.fields)) {
        const o = obj(f);
        if (str(o.title)?.toLowerCase() === name) return str(o.value);
      }
      return undefined;
    };
    const title = str(att.title) ?? raw.title;
    const link = str(att.title_link);
    const issueId = link?.match(/issues\/(\d+)/)?.[1];
    return withOptional<Signal>(
      {
        id: `glitchtip:${shortHash(link ?? title, raw.receivedAt)}`,
        provider: "glitchtip",
        projectId,
        kind: "error",
        title,
        message: str(att.text) ?? "",
        level: "error",
        occurredAt: new Date(raw.receivedAt).toISOString(),
        frames: [],
        // Alert text is derived from client-reported events.
        trust: "client",
        userHashes: [],
        reportedUsers: 0,
        count: 1,
      },
      {
        release: field("release"),
        environment: field("environment"),
        providerFingerprint: issueId,
        url: link,
      },
    );
  });
}
