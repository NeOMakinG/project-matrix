import { getJson, type HttpOptions } from "../http.js";
import type { Dependency, WatchItem } from "../types.js";

export function parseVersion(v: string): [number, number, number] | null {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/** "major" | "minor" | "patch" when `latest` is newer than `current`, else null. Pre-release tags are ignored. */
export function bumpKind(current: string, latest: string): "major" | "minor" | "patch" | null {
  if (/-/.test(latest)) return null;
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return null;
  if (b[0] > a[0]) return "major";
  if (b[0] < a[0]) return null;
  if (b[1] > a[1]) return "minor";
  if (b[1] < a[1]) return null;
  return b[2] > a[2] ? "patch" : null;
}

export interface RegistryInfo {
  latest: string;
  publishedAt?: string;
  repository?: string;
  url: string;
}

export async function registryInfo(
  dep: Dependency,
  http: HttpOptions = {},
): Promise<RegistryInfo | null> {
  const name = encodeURIComponent(dep.name).replace("%40", "@");
  if (dep.ecosystem === "npm") {
    // The full packument can be many MB; `/latest` is the small manifest of the latest dist-tag.
    const d = await getJson<{ version?: string; repository?: { url?: string } | string }>(
      `https://registry.npmjs.org/${name}/latest`,
      http,
    );
    if (!d.version) return null;
    const repo = typeof d.repository === "string" ? d.repository : d.repository?.url;
    return {
      latest: d.version,
      url: `https://www.npmjs.com/package/${dep.name}`,
      ...(repo ? { repository: repo } : {}),
    };
  }
  if (dep.ecosystem === "crates") {
    const d = await getJson<{
      crate?: { max_stable_version?: string; repository?: string; updated_at?: string };
    }>(`https://crates.io/api/v1/crates/${name}`, http);
    const latest = d.crate?.max_stable_version;
    if (!latest) return null;
    return {
      latest,
      url: `https://crates.io/crates/${dep.name}`,
      ...(d.crate?.updated_at ? { publishedAt: d.crate.updated_at } : {}),
      ...(d.crate?.repository ? { repository: d.crate.repository } : {}),
    };
  }
  const d = await getJson<{
    info?: { version?: string; project_urls?: Record<string, string> | null };
  }>(`https://pypi.org/pypi/${name}/json`, http);
  const latest = d.info?.version;
  if (!latest) return null;
  const urls = d.info?.project_urls ?? {};
  const repo = Object.values(urls).find((u) => /github\.com/.test(u));
  return {
    latest,
    url: `https://pypi.org/project/${dep.name}/`,
    ...(repo ? { repository: repo } : {}),
  };
}

/** Upgrade candidates: one item per dependency whose registry latest is ahead of what the project uses. */
export async function collectRegistryUpgrades(
  deps: Dependency[],
  http: HttpOptions = {},
  infos = new Map<string, RegistryInfo | null>(),
): Promise<WatchItem[]> {
  const out: WatchItem[] = [];
  for (const dep of deps) {
    const key = `${dep.ecosystem}:${dep.name}`;
    let info = infos.get(key);
    if (info === undefined) {
      info = await registryInfo(dep, http).catch(() => null);
      infos.set(key, info);
    }
    if (!info) continue;
    const current = dep.resolved ?? dep.version;
    const bump = bumpKind(current, info.latest);
    if (!bump) continue;
    out.push({
      id: `registry:${key}@${info.latest}`,
      source: "registry",
      title: `${dep.name} ${info.latest} available (${bump}, you use ${current})`,
      url: info.url,
      summary: `${dep.ecosystem} ${bump} update`,
      dependency: dep.name,
      version: info.latest,
      ...(info.publishedAt ? { publishedAt: info.publishedAt } : {}),
    });
  }
  return out;
}
