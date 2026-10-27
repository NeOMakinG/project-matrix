/**
 * Per-project deploy profile (ADR 0007). Trusted operator config stored with the project, never
 * read from ticket text or the repo: which targets a merged diff deploys, how each one proves the
 * merged commit reached production, and which changes must hold the deploy for a human.
 */

/** Deploy CLIs a `command` target may run (host-side allowlist, fixed subcommands). */
export const DEPLOY_CAPABILITIES = ["fly", "eas", "railway", "gh"] as const;
export type DeployCapability = (typeof DEPLOY_CAPABILITIES)[number];

/** Allowed `run` prefixes per capability: argv[0] and its first subcommand words. */
export const DEPLOY_COMMANDS: Record<DeployCapability, readonly (readonly string[])[]> = {
  fly: [["fly", "deploy"]],
  eas: [
    ["eas", "build"],
    ["eas", "update"],
    ["eas", "submit"],
  ],
  railway: [
    ["railway", "up"],
    ["railway", "redeploy"],
  ],
  gh: [["gh", "workflow", "run"]],
};

export interface DeployHealth {
  /** `https://` public origin only (checked at config write and again before polling). */
  url: string;
  /** Expected HTTP status. */
  expect: number;
}

export interface DeployTarget {
  name: string;
  /**
   * `git-integration`: the provider deploys on merge to the base branch (Netlify, Vercel...);
   * Matrix only proves and checks it. `command`: Matrix runs `run` on a host with `capability`.
   */
  kind: "git-integration" | "command";
  /** Paths (prefixes or globs) whose change selects this target; `**` = every merge. */
  paths: string[];
  health?: DeployHealth;
  /**
   * Production proof for `git-integration`: a public JSON document whose `field` names the commit
   * production serves (e.g. Netlify `/version.json` built from `COMMIT_REF`).
   */
  version?: { url: string; field: string };
  /** Informational: the preview status context the QA lane waits on (`deploy/netlify`). */
  waitStatus?: string;
  capability?: DeployCapability;
  run?: string[];
  rollback?: { kind: "fly-releases"; app: string };
  /** Globs that merge but hold this target's deploy for a human (migrations, release config). */
  holdOn?: string[];
  /** Shared infra another fleet deploys too: deck note + recent foreign release check first. */
  coordinate?: { deck: boolean; recentForeignDeployMinutes: number };
  /** Plan only: print what would run, run nothing (operator dry run). */
  dryRun?: boolean;
}

export interface DeployProfile {
  /** `auto`: Matrix merges once every gate holds (0 P1, green CI, agent QA PASS). */
  merge: "auto" | "human";
  targets: DeployTarget[];
}

/** Root files whose change can alter every build: they select every target. */
const ROOT_MANIFESTS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  ".npmrc",
  ".nvmrc",
  ".node-version",
]);

const globCache = new Map<string, RegExp>();

/** `**` any depth, `*` within a segment, `?` one char; everything else literal. */
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const re = new RegExp(`^${out}$`);
  if (globCache.size > 500) globCache.clear();
  globCache.set(glob, re);
  return re;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** A `paths` entry: a glob when it has a wildcard, else the path itself or anything under it. */
export function pathSelects(entry: string, path: string): boolean {
  const e = normalize(entry).replace(/\/+$/, "");
  const p = normalize(path);
  if (/[*?]/.test(e)) return globToRegExp(e).test(p);
  return p === e || p.startsWith(`${e}/`);
}

export function globMatches(glob: string, path: string): boolean {
  return globToRegExp(normalize(glob)).test(normalize(path));
}

export interface TargetSelection {
  target: DeployTarget;
  /** Changed paths that selected the target (root manifests included). */
  matched: string[];
  /** Changed paths matching `holdOn`: non-empty = merge, but hold this deploy for a human. */
  held: string[];
}

/**
 * Targets a merged diff deploys. A target runs when the diff touches its `paths` or `holdOn`
 * globs, and root manifests/lockfiles select every target. `holdOn` is evaluated on its own,
 * whatever selected the target. An unknown diff (`undefined`) selects every target.
 */
export function selectTargets(
  profile: DeployProfile,
  changedPaths: readonly string[] | undefined,
): TargetSelection[] {
  const out: TargetSelection[] = [];
  for (const target of profile.targets) {
    if (changedPaths === undefined) {
      out.push({ target, matched: ["(diff unknown)"], held: ["(diff unknown)"] });
      continue;
    }
    const held = changedPaths.filter((p) => (target.holdOn ?? []).some((g) => globMatches(g, p)));
    const matched = changedPaths.filter(
      (p) => ROOT_MANIFESTS.has(normalize(p)) || target.paths.some((e) => pathSelects(e, p)),
    );
    if (matched.length || held.length) out.push({ target, matched, held });
  }
  return out;
}

/** Problems with a deploy profile (empty = valid). Shape is checked by the HTTP schema. */
export function deployProfileProblems(profile: DeployProfile): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const t of profile.targets) {
    const at = `deploy.targets.${t.name}`;
    if (names.has(t.name)) problems.push(`${at}: duplicate target name`);
    names.add(t.name);
    for (const url of [t.health?.url, t.version?.url])
      if (url !== undefined) {
        const reason = publicHttpsProblem(url);
        if (reason) problems.push(`${at}: ${reason}`);
      }
    if (t.kind === "git-integration") {
      if (t.run || t.capability || t.rollback)
        problems.push(`${at}: git-integration targets run nothing (no run/capability/rollback)`);
      if (!t.version)
        problems.push(
          `${at}: git-integration targets need version {url, field} as production proof`,
        );
      // The provider deploys on merge by itself: a hold could not stop it, so it is refused.
      if (t.holdOn?.length)
        problems.push(
          `${at}: holdOn cannot hold a git-integration target (the provider deploys on merge)`,
        );
    } else {
      if (!t.capability || !t.run?.length)
        problems.push(`${at}: command targets need capability and run`);
      else {
        const allowed = DEPLOY_COMMANDS[t.capability];
        if (!allowed?.some((prefix) => prefix.every((w, i) => t.run?.[i] === w)))
          problems.push(
            `${at}: run must start with ${allowed?.map((p) => p.join(" ")).join(" | ")} for ${t.capability}`,
          );
        if (t.run.some((a) => /[\0\n\r]/.test(a) || a.length > 200))
          problems.push(`${at}: run arguments must be single-line and short`);
      }
      // Production proof is implemented for Fly only (release image label); others stay human.
      if (t.capability && t.capability !== "fly")
        problems.push(
          `${at}: only fly command targets are supported (no production proof for ${t.capability} yet)`,
        );
      if (t.capability === "fly" && !t.rollback?.app)
        problems.push(
          `${at}: fly targets need rollback {kind: fly-releases, app} (also the release proof)`,
        );
      if (!t.health) problems.push(`${at}: command targets need a health check`);
    }
  }
  return problems;
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT / Tailscale
];

/** True for loopback, private, link-local, CGNAT/tailnet and unique-local addresses. */
export function isPrivateAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (a.startsWith("::ffff:")) return isPrivateAddress(a.slice(7));
  if (PRIVATE_V4.some((re) => re.test(a))) return true;
  if (a === "::1" || a === "::") return true;
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(a);
}

/** Reason a URL is not an https public origin (null when fine). Hostnames only, no DNS. */
export function publicHttpsProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `not a URL: ${raw.slice(0, 80)}`;
  }
  if (url.protocol !== "https:") return "health/version URLs must be https://";
  if (url.username || url.password) return "URLs must not carry credentials";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".ts.net") ||
    !host.includes(".")
  )
    return `${host} is not a public origin`;
  if (/^[\d.]+$/.test(host) || host.includes(":"))
    return isPrivateAddress(host) ? `${host} is a private address` : null;
  return null;
}
