const DEFAULT_HTTPS_HOSTS = ["github.com"];

function allowedHosts(): string[] {
  const extra = (import.meta.env.VITE_LINK_HOSTS ?? "")
    .split(",")
    .map((h: string) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_HTTPS_HOSTS, ...extra];
}

/** Returns the URL only if it is https: on an allowed host (exact or subdomain). */
export function safeHttpsUrl(
  value: unknown,
  hosts: readonly string[] = allowedHosts(),
): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const ok = hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  return ok ? url.toString() : null;
}

const ORCA_LINK = /^orca:\/\/[A-Za-z0-9._~\-/]+$/;

/** Returns the link only if it is an orca:// deep link with a plain path. */
export function safeOrcaUrl(value: unknown): string | null {
  return typeof value === "string" && ORCA_LINK.test(value) ? value : null;
}
