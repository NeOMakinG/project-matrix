import { stripTags } from "../feed.js";
import { getJson, getText, type HttpOptions } from "../http.js";
import type { WatchItem } from "../types.js";

/** Normalises npm/crates/pypi repository strings to `owner/repo` when they point at GitHub. */
export function githubRepo(repository: string | undefined): string | null {
  if (!repository) return null;
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(repository);
  return m ? `${m[1]}/${m[2]}` : null;
}

interface Release {
  html_url: string;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

export async function collectGithubReleases(
  repos: { repo: string; dependency: string }[],
  days: number,
  http: HttpOptions = {},
): Promise<WatchItem[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const headers = { accept: "application/vnd.github+json", ...http.headers };
  const out: WatchItem[] = [];
  for (const { repo, dependency } of [...repos].sort((a, b) => a.repo.localeCompare(b.repo))) {
    const releases = await getJson<Release[]>(
      `https://api.github.com/repos/${repo}/releases?per_page=5`,
      {
        ...http,
        headers,
      },
    ).catch(() => [] as Release[]);
    for (const r of releases) {
      if (r.draft || r.prerelease || !r.published_at || Date.parse(r.published_at) < cutoff)
        continue;
      out.push({
        id: `gh-release:${repo}@${r.tag_name}`,
        source: "github-release",
        title: `${repo} ${r.name || r.tag_name}`,
        url: r.html_url,
        summary: (r.body ?? "").replace(/\s+/g, " ").slice(0, 600),
        publishedAt: r.published_at,
        dependency,
        version: r.tag_name,
      });
    }
  }
  return out;
}

/** Parses github.com/trending HTML (no API exists). Each `article.Box-row` holds one repository. */
export function parseTrending(
  html: string,
): { repo: string; description: string; stars: string }[] {
  return [...html.matchAll(/<article class="Box-row"[\s\S]*?<\/article>/g)].flatMap((m) => {
    const block = m[0];
    const href = /<h2[\s\S]*?href="\/([^"/]+\/[^"/]+)"/.exec(block)?.[1];
    if (!href) return [];
    const description = stripTags(
      /<p class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? "",
    );
    const stars = stripTags(
      /([\d,]+)\s*stars (?:today|this week|this month)/.exec(block)?.[0] ?? "",
    );
    return [{ repo: href, description, stars }];
  });
}

export async function collectGithubTrending(
  languages: string[],
  http: HttpOptions = {},
): Promise<WatchItem[]> {
  const out: WatchItem[] = [];
  for (const lang of [...new Set(languages)].sort()) {
    const html = await getText(
      `https://github.com/trending/${encodeURIComponent(lang)}?since=weekly`,
      http,
    );
    for (const t of parseTrending(html)) {
      out.push({
        id: `gh-trending:${t.repo}`,
        source: "github-trending",
        title: `${t.repo} trending in ${lang}`,
        url: `https://github.com/${t.repo}`,
        summary: [t.description, t.stars].filter(Boolean).join(" · "),
      });
    }
  }
  return out;
}
