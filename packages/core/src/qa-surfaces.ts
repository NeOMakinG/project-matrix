import type { ProjectConfig, QaSurface } from "./types.js";

/**
 * Surface routing for device/browser QA: which of android, ios and web a ticket's change needs.
 *
 * Inputs, from least to most trusted:
 * - ticket text (`QA: Surface: ios` lines) and ticket labels (`ios`, `platform:android`, ...): they
 *   only NARROW among the project's configured surfaces, never add one and never remove all;
 * - the change's paths (host-computed diff): they narrow platform-specific changes and mark a
 *   backend-only change, which keeps the existing host/api checks instead of device QA;
 * - the project config (`qa.surfaces`, operator-trusted): the upper bound.
 */

const DEVICE: ReadonlySet<QaSurface> = new Set(["android", "ios"]);

/** Surfaces an out-of-run driver tests: devices always, web only with the agent lane (Chrome). */
export function laneSurfaceSet(project: ProjectConfig): ReadonlySet<QaSurface> {
  return project.qa?.driver === "agent" ? new Set([...DEVICE, "web"]) : DEVICE;
}

const LABEL_WORDS: Record<string, QaSurface | "backend"> = {
  android: "android",
  ios: "ios",
  iphone: "ios",
  web: "web",
  backend: "backend",
  api: "backend",
  server: "backend",
};

/** Surfaces named by ticket labels: `ios`, `platform:ios`, `surface: web`, `qa-android`... */
export function labelSurfaces(labels: readonly string[]): (QaSurface | "backend")[] {
  const out = new Set<QaSurface | "backend">();
  for (const raw of labels) {
    const label = raw.toLowerCase().trim();
    // Matrix's own verdict labels are never a routing declaration.
    if (/^qa:(passed|failed)$/.test(label)) continue;
    const m = label.match(/^(?:(?:platform|surface|qa)\s*[:/-]\s*)?([a-z]+)$/);
    const word = m?.[1] ? LABEL_WORDS[m[1]] : undefined;
    if (word) out.add(word);
  }
  return [...out];
}

export type PathKind = QaSurface | "backend" | "shared";

const BACKEND_DIRS = new Set([
  "server",
  "backend",
  "api",
  "supabase",
  "functions",
  "lambda",
  "migrations",
  "infra",
  "terraform",
  "ops",
  "docs",
  ".github",
  "workers",
]);
const WEB_DIRS = new Set(["web", "site", "landing", "www", "public"]);
const GROUPS = new Set(["apps", "packages", "services"]);

/** What one changed path touches. Unknown UI-ish code is `shared` (every configured surface). */
export function classifyPath(path: string): PathKind {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = p.split("/");
  const lower = p.toLowerCase();
  if (/\.ios\.[cm]?[jt]sx?$/.test(lower) || parts.includes("ios")) return "ios";
  if (
    /(^|\/)(podfile(\.lock)?|info\.plist)$|\.(xcodeproj|xcworkspace|entitlements)(\/|$)/.test(lower)
  )
    return "ios";
  if (/\.android\.[cm]?[jt]sx?$/.test(lower) || parts.includes("android")) return "android";
  if (/\.gradle(\.kts)?$|(^|\/)androidmanifest\.xml$/.test(lower)) return "android";
  if (/\.web\.[cm]?[jt]sx?$/.test(lower)) return "web";
  const top = GROUPS.has(parts[0] ?? "") && parts.length > 2 ? (parts[1] ?? "") : (parts[0] ?? "");
  if (WEB_DIRS.has(top.toLowerCase())) return "web";
  if (BACKEND_DIRS.has(top.toLowerCase())) return "backend";
  if (/\.(md|sql|txt)$/.test(lower) || /(^|\/)(dockerfile|docker-compose[^/]*\.ya?ml)$/.test(lower))
    return "backend";
  return "shared";
}

export interface SurfaceRoute {
  /** Surfaces a lane driver must test; PASS needs every one of them to pass. */
  surfaces: QaSurface[];
  /** The diff touches backend/docs only: no device/browser QA, the existing checks decide. */
  backendOnly: boolean;
  /** Why these surfaces (for logs and the PR text). */
  source: "config" | "declared" | "paths" | "backend-only" | "none";
}

/**
 * Lane surfaces for a ticket. `changedPaths` undefined = diff unknown (no path narrowing).
 * Never returns a surface the project does not configure.
 */
export function routeQaSurfaces(
  project: ProjectConfig,
  ticket: { body: string; labels?: readonly string[] },
  changedPaths?: readonly string[],
  declaredInBody: readonly QaSurface[] = [],
): SurfaceRoute {
  const lane = laneSurfaceSet(project);
  const configured = (project.qa?.surfaces ?? []).filter((s) => lane.has(s));
  if (!configured.length) return { surfaces: [], backendOnly: false, source: "none" };
  let surfaces = configured;
  let source: SurfaceRoute["source"] = "config";
  const declared = new Set<string>(declaredInBody);
  for (const s of labelSurfaces(ticket.labels ?? []))
    for (const d of s === "backend" ? ["host", "api"] : [s]) declared.add(d);
  // A declaration narrows among the configured lane surfaces. One naming none of them (only
  // backend/host/api, or nothing configured) is ignored: only a backend-only diff skips lane QA.
  const narrowed = configured.filter((s) => declared.has(s));
  if (narrowed.length) {
    surfaces = narrowed;
    source = "declared";
  }
  if (!changedPaths?.length) return { surfaces, backendOnly: false, source };
  const kinds = new Set(changedPaths.map(classifyPath));
  if (kinds.size === 1 && kinds.has("backend"))
    return { surfaces: [], backendOnly: true, source: "backend-only" };
  // The diff outranks a declaration: a configured platform the change touches is always tested.
  const touched = configured.filter((s) => kinds.has(s) && !surfaces.includes(s));
  if (touched.length)
    surfaces = configured.filter((s) => surfaces.includes(s) || touched.includes(s));
  // Shared UI code (or anything unclassified) reaches every surface still selected.
  if (kinds.has("shared")) return { surfaces, backendOnly: false, source };
  const byPath = surfaces.filter((s) => kinds.has(s));
  return byPath.length && byPath.length < surfaces.length
    ? { surfaces: byPath, backendOnly: false, source: "paths" }
    : { surfaces, backendOnly: false, source };
}
