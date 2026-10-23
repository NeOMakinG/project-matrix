/**
 * Matrix's per-issue bookkeeping (phase, blocked flag, live comment ids) for Linear. It used to
 * ride in a `<!-- matrix:{...} -->` block at the end of the issue description, which Linear renders
 * as visible text (and rewrites `-->` into an arrow). It now lives host-side, keyed by the issue's
 * UUID inside one project's store; old blocks are still read and migrated away.
 */
import { sanitizeUntrusted } from "../sanitize.js";
import type { LinearMeta } from "./linear-mapping.js";

export interface LinearMetaStore {
  get(issueUuid: string): LinearMeta | undefined;
  set(issueUuid: string, meta: LinearMeta): void;
}

/** Process-local meta (tests, short-lived tools). Production passes a persistent store. */
export class MemoryLinearMetaStore implements LinearMetaStore {
  readonly #m = new Map<string, LinearMeta>();
  get(id: string): LinearMeta | undefined {
    const v = this.#m.get(id);
    return v ? structuredClone(v) : undefined;
  }
  set(id: string, meta: LinearMeta): void {
    this.#m.set(id, structuredClone(meta));
  }
}

/**
 * The legacy block as Matrix wrote it, also after Linear's round-trip (`-->` shown as `→`, or
 * HTML-escaped). Anchored at the very end of the description.
 */
const LEGACY_BLOCK = /\n*(?:<!--|&lt;!--)[ \t]*matrix:(\{[^\n]*?\})[ \t]*(?:-->|--&gt;|→)\s*$/s;

/** Keys Matrix ever wrote into the block; anything else means it is not (only) Matrix's. */
const MATRIX_KEYS = new Set([
  "phase",
  "blocked",
  "blockedIn",
  "comments",
  "status",
  "priority",
  "deps",
  "parent",
  "related",
]);

export interface LegacyBlock {
  /** Description with the block removed, byte-for-byte otherwise (trailing spaces trimmed). */
  text: string;
  /** Raw parsed meta, still untrusted: validate before use. */
  meta: Record<string, unknown>;
}

/**
 * Finds a Matrix-format block at the end of `description`. Returns undefined unless the block
 * parses as a JSON object using only Matrix's keys, so a stray human comment is never touched.
 */
export function findLegacyBlock(description: string | null): LegacyBlock | undefined {
  if (!description) return undefined;
  const match = LEGACY_BLOCK.exec(description);
  if (!match?.[1]) return undefined;
  let meta: unknown;
  try {
    meta = JSON.parse(match[1].replace(/&quot;/g, '"'));
  } catch {
    return undefined;
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  if (!Object.keys(meta).every((k) => MATRIX_KEYS.has(k))) return undefined;
  return {
    text: description.slice(0, match.index).trimEnd(),
    meta: meta as Record<string, unknown>,
  };
}

/** The description text without a legacy block, sanitized for consumers. */
export function descriptionText(description: string | null): string {
  const block = findLegacyBlock(description);
  return sanitizeUntrusted(block ? block.text : (description ?? ""));
}
