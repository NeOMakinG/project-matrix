import type { RawSignal, Signal } from "../signal.js";
import { isoTime, num, obj, shortHash, str, withOptional } from "./util.js";

/**
 * Uptime checks. Supports Uptime Kuma webhooks (`heartbeat.status` 0 = down) and a generic
 * `{ monitor: { name, url }, status: "down" | "up", checkedAt, statusCode, error }` shape.
 * Only "down" produces a signal.
 */
export function normalizeUptime(raw: RawSignal, projectId: string): Signal[] {
  const payload = obj(raw.payload);
  const monitor = obj(payload.monitor);
  const heartbeat = obj(payload.heartbeat);
  const kumaDown = Object.keys(heartbeat).length > 0 && num(heartbeat.status) === 0;
  const genericDown = str(payload.status)?.toLowerCase() === "down";
  if (!kumaDown && !genericDown) return [];

  const name = str(monitor.name) ?? raw.title;
  const url = str(monitor.url);
  const time = heartbeat.time ?? payload.checkedAt;
  const statusCode = num(payload.statusCode);
  const reason =
    str(heartbeat.msg) ?? str(payload.error) ?? (statusCode ? `HTTP ${statusCode}` : "down");
  return [
    withOptional<Signal>(
      {
        id: `uptime:${shortHash(name, String(time ?? raw.receivedAt))}`,
        provider: "uptime",
        projectId,
        kind: "downtime",
        title: `${name} is down`,
        message: reason,
        level: "fatal",
        occurredAt: isoTime(time, raw.receivedAt),
        frames: [],
        trust: "infra",
        userHashes: [],
        reportedUsers: 0,
        count: 1,
      },
      { exceptionType: "Downtime", providerFingerprint: `uptime:${url ?? name}`, url },
    ),
  ];
}
