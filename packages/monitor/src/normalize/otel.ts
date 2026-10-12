import type { RawSignal, Signal } from "../signal.js";
import { arr, isoTime, level, obj, shortHash, str, withOptional } from "./util.js";

/**
 * OpenTelemetry-driven alerts delivered through an Alertmanager-compatible webhook
 * (Prometheus Alertmanager, Grafana alerting, SigNoz). Resolved alerts are dropped:
 * recovery is measured by the verify step, not by the alert source.
 */
export function normalizeOtel(raw: RawSignal, projectId: string): Signal[] {
  const payload = obj(raw.payload);
  const common = obj(payload.commonLabels);
  const out: Signal[] = [];
  for (const a of arr(payload.alerts)) {
    const alert = obj(a);
    if (str(alert.status) === "resolved") continue;
    const labels = { ...common, ...obj(alert.labels) };
    const ann = obj(alert.annotations);
    const name = str(labels.alertname) ?? raw.title;
    const fingerprint = str(alert.fingerprint) ?? shortHash(name, JSON.stringify(labels));
    out.push(
      withOptional<Signal>(
        {
          id: `otel:${fingerprint}:${str(alert.startsAt) ?? raw.receivedAt}`,
          provider: "otel",
          projectId: str(labels.project) ?? projectId,
          kind: "alert",
          title: str(ann.summary) ?? name,
          message: str(ann.description) ?? "",
          level: level(labels.severity, "warning"),
          occurredAt: isoTime(alert.startsAt, raw.receivedAt),
          frames: [],
          trust: "infra",
          userHashes: [],
          reportedUsers: 0,
          count: 1,
        },
        {
          release: str(labels.release) ?? str(labels.version) ?? str(labels["service.version"]),
          environment: str(labels.environment) ?? str(labels.env),
          exceptionType: name,
          providerFingerprint: `${name}:${str(labels.service) ?? str(labels.job) ?? "all"}`,
          url: str(alert.generatorURL),
        },
      ),
    );
  }
  return out;
}
