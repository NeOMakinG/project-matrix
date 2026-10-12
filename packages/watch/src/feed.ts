export interface FeedEntry {
  title: string;
  url: string;
  summary: string;
  publishedAt?: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the five XML entities and numeric references only; never expands DTD-declared entities. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1]?.toLowerCase() === "x" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m?.[1];
}

function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1] ?? "");
  const pick =
    links.find((a) => /rel=["']alternate["']/i.test(a)) ??
    links.find((a) => !/rel=/i.test(a)) ??
    links[0];
  return pick ? /href=["']([^"']+)["']/i.exec(pick)?.[1] : undefined;
}

/** Minimal RSS 2.0 / Atom parser. Regex based on purpose: feeds are untrusted and we only need four fields. */
export function parseFeed(xml: string): FeedEntry[] {
  const body = xml.replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const isAtom = /<feed\b/i.test(body);
  const blocks = [
    ...body.matchAll(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi),
  ].map((m) => m[0]);
  const out: FeedEntry[] = [];
  for (const block of blocks) {
    const title = stripTags(tag(block, "title") ?? "");
    const url = isAtom
      ? atomLink(block)
      : stripTags(tag(block, "link") ?? "") || stripTags(tag(block, "guid") ?? "");
    if (!title || !url) continue;
    const summary = stripTags(
      tag(block, isAtom ? "summary" : "description") ?? tag(block, "content") ?? "",
    ).slice(0, 500);
    const date = stripTags(
      tag(block, isAtom ? "updated" : "pubDate") ??
        tag(block, "published") ??
        tag(block, "dc:date") ??
        "",
    );
    const parsed = date ? new Date(date) : undefined;
    out.push({
      title,
      url: decodeEntities(url),
      summary,
      ...(parsed && !Number.isNaN(parsed.getTime()) ? { publishedAt: parsed.toISOString() } : {}),
    });
  }
  return out;
}
