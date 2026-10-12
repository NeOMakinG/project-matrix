import { createHash } from "node:crypto";

/** Strong ETag over a stable (key-sorted) JSON serialization of the settings. */
export function settingsEtag(settings: Record<string, unknown>): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, stable(v)]),
          )
        : value;
  return `"${createHash("sha256")
    .update(JSON.stringify(stable(settings)))
    .digest("hex")
    .slice(0, 32)}"`;
}

/** ETag over a project's autonomy map, for atomic policy updates. */
export function autonomyEtag(policy: { version: string }): string {
  return `"${policy.version}"`;
}
