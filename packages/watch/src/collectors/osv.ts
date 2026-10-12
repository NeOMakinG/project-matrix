import type { HttpOptions } from "../http.js";
import type { Dependency, WatchItem } from "../types.js";

const OSV_ECOSYSTEM = { npm: "npm", crates: "crates.io", pypi: "PyPI" } as const;

interface OsvVuln {
  id: string;
  summary?: string;
  database_specific?: { severity?: string };
}

function severity(v: OsvVuln): WatchItem["severity"] {
  const s = v.database_specific?.severity?.toLowerCase();
  return s === "critical" || s === "high" || s === "moderate" || s === "low" ? s : undefined;
}

/** Known vulnerabilities for the concrete versions in use (deps without a resolved version are skipped). */
export async function collectOsv(deps: Dependency[], http: HttpOptions = {}): Promise<WatchItem[]> {
  const pinned = deps.filter((d) => d.resolved);
  if (!pinned.length) return [];
  const f = http.fetch ?? fetch;
  const res = await f("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: pinned.map((d) => ({
        package: { name: d.name, ecosystem: OSV_ECOSYSTEM[d.ecosystem] },
        version: d.resolved,
      })),
    }),
  });
  if (!res.ok) throw new Error(`osv querybatch -> ${res.status}`);
  const data = (await res.json()) as { results: { vulns?: OsvVuln[] }[] };
  const out: WatchItem[] = [];
  data.results.forEach((result, i) => {
    const dep = pinned[i]!;
    for (const v of result.vulns ?? []) {
      const sev = severity(v);
      out.push({
        id: `osv:${v.id}:${dep.name}`,
        source: "osv",
        title: `${v.id} affects ${dep.name}@${dep.resolved}`,
        url: `https://osv.dev/vulnerability/${v.id}`,
        summary: v.summary ?? "",
        dependency: dep.name,
        ...(dep.resolved ? { version: dep.resolved } : {}),
        ...(sev ? { severity: sev } : {}),
      });
    }
  });
  return out;
}
