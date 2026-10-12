import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const u = normalizeUrl(item.url);
    const t = titleKey(item.title);
    const duplicate = seenUrl.has(u) || seenTitle.has(t);
    seenUrl.add(u);
    seenTitle.add(t);
    if (!duplicate) out.push(item);
  }
  return out;
}

/** Remembers item ids across runs so a weekly digest only shows what is new. */
export class SeenStore {
  constructor(private readonly path: string) {}

  async load(): Promise<Set<string>> {
    try {
      return new Set(JSON.parse(await readFile(this.path, "utf8")) as string[]);
    } catch {
      return new Set();
    }
  }

  async save(ids: Set<string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify([...ids].sort(), null, 0)}\n`);
    await rename(tmp, this.path);
  }
}
