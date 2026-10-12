import { getJson, type HttpOptions } from "../http.js";
import type { WatchItem } from "../types.js";

interface AlgoliaHit {
  objectID: string;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  points?: number | null;
  created_at?: string;
}

/** HN stories from the last `days` days matching each keyword, via the Algolia API. */
export async function collectHn(
  keywords: string[],
  days: number,
  http: HttpOptions = {},
): Promise<WatchItem[]> {
  const since = Math.floor(Date.now() / 1000) - days * 86_400;
  const out: WatchItem[] = [];
  for (const keyword of [...new Set(keywords)].sort()) {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(keyword)}&tags=story&numericFilters=created_at_i>${since},points>20&hitsPerPage=10`;
    const data = await getJson<{ hits: AlgoliaHit[] }>(url, http);
    for (const hit of data.hits) {
      const title = hit.title ?? hit.story_title;
      if (!title) continue;
      out.push({
        id: `hn:${hit.objectID}`,
        source: "hn",
        title,
        url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
        summary: `${hit.points ?? 0} points · query "${keyword}"`,
        ...(hit.created_at ? { publishedAt: hit.created_at } : {}),
      });
    }
  }
  return out;
}
