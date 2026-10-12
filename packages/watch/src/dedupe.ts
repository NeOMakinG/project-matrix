import { readFileSafe, safeJoin, writeFileSafe } from "@matrix/safe-fs";
import type { WatchItem } from "./types.js";

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) if (/^utm_|^ref$/.test(p)) u.searchParams.delete(p);
    return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${u.search}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

const titleKey = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Keeps the first item per normalised URL or title; output sorted by id for determinism. */
export function dedupe(items: WatchItem[]): WatchItem[] {
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const out: WatchItem[] = [];
  const advisories = new Set<string>();
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    // One advisory URL covers many packages: dedupe advisories by advisory id + package only.
    if (item.source === "osv") {
      if (!advisories.has(item.id)) out.push(item);
      advisories.add(item.id);
      continue;
    }
    const u = normalizeUrl(item.url);
    const t = titleKey(item.title);
    const duplicate = seenUrl.has(u) || seenTitle.has(t);
    seenUrl.add(u);
    seenTitle.add(t);
    if (!duplicate) out.push(item);
  }
  return out;
}

/** Remembers item ids across runs so a weekly digest only shows what is new. Writes never follow symlinks. */
export class SeenStore {
  readonly path: string;
  constructor(private readonly root: string) {
    this.path = safeJoin(root, ".matrix", "watch", "seen.json");
  }

  async load(): Promise<Set<string>> {
    const raw = await readFileSafe(this.root, this.path);
    if (raw === null) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [],
    );
  }

  async save(ids: Set<string>): Promise<void> {
    await writeFileSafe(this.root, this.path, `${JSON.stringify([...ids].sort())}\n`);
  }
}
