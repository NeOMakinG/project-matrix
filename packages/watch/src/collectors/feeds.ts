import { parseFeed } from "../feed.js";
import { getText, type HttpOptions } from "../http.js";
import type { WatchItem } from "../types.js";

export async function collectFeeds(
  urls: string[],
  days: number,
  http: HttpOptions = {},
): Promise<WatchItem[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const out: WatchItem[] = [];
  for (const url of [...new Set(urls)].sort()) {
    for (const entry of parseFeed(await getText(url, http))) {
      if (entry.publishedAt && Date.parse(entry.publishedAt) < cutoff) continue;
      out.push({
        id: `feed:${entry.url}`,
        source: "feed",
        title: entry.title,
        url: entry.url,
        summary: entry.summary,
        ...(entry.publishedAt ? { publishedAt: entry.publishedAt } : {}),
      });
    }
  }
  return out;
}

/** arXiv Atom API, newest first. */
export async function collectArxiv(
  query: string,
  max: number,
  days: number,
  http: HttpOptions = {},
): Promise<WatchItem[]> {
  const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`;
  const cutoff = Date.now() - days * 86_400_000;
  return parseFeed(await getText(url, http))
    .filter((e) => !e.publishedAt || Date.parse(e.publishedAt) >= cutoff)
    .map((e) => ({
      id: `arxiv:${e.url}`,
      source: "arxiv" as const,
      title: e.title,
      url: e.url,
      summary: e.summary,
      ...(e.publishedAt ? { publishedAt: e.publishedAt } : {}),
    }));
}
