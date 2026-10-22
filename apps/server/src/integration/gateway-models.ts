import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { FactoryToolingError } from "@matrix/core";
import type { ModelLister } from "./model-plan.js";

const HOUR_MS = 60 * 60_000;

export interface ServedModelsOptions {
  /** A list younger than this is fresh: no gateway call at all (default 60 s). */
  ttlMs?: number;
  /** When the gateway is slow or down, the last good list is trusted up to this age (default 24 h). */
  staleMs?: number;
  /** After a failed fetch, no new fetch for this long, doubling up to `maxRetryMs` (default 30 s). */
  retryMs?: number;
  maxRetryMs?: number;
  /** Persists the last good list so a restart during a gateway outage keeps working. */
  cacheFile?: string;
  /** Identifies the gateway (e.g. a URL hash, never a key): another gateway's cache is ignored. */
  cacheKey?: string;
  now?: () => number;
}

/**
 * Gateway model list with stale-while-revalidate, used to refuse ids the gateway does not serve.
 * A slow or unreachable gateway is not a ticket failure: a cached list (≤ `staleMs`) stands in, and
 * without one the error carries the "gateway unavailable" wording core defers on (no attempt spent).
 */
export function servedModels(list: ModelLister, o: ServedModelsOptions = {}) {
  const ttl = o.ttlMs ?? 60_000;
  const stale = o.staleMs ?? 24 * HOUR_MS;
  const base = o.retryMs ?? 30_000;
  const max = o.maxRetryMs ?? 5 * 60_000;
  const now = o.now ?? Date.now;
  let good: { at: number; ids: Set<string> } | undefined;
  let loaded: Promise<void> | undefined;
  let failures = 0;
  let retryAt = 0;
  let inflight: Promise<void> | undefined;

  const load = () =>
    (loaded ??= (async () => {
      if (!o.cacheFile) return;
      try {
        const raw = JSON.parse(await readFile(o.cacheFile, "utf8")) as {
          at?: unknown;
          ids?: unknown;
          key?: unknown;
        };
        if ((raw.key ?? undefined) !== o.cacheKey) return;
        if (typeof raw.at !== "number" || raw.at > now() || !Array.isArray(raw.ids)) return;
        const ids = raw.ids.filter((id): id is string => typeof id === "string");
        if (!good || raw.at > good.at) good = { at: raw.at, ids: new Set(ids) };
      } catch {
        // No or unreadable cache: behave as a cold start.
      }
    })());

  const persist = async (file: string, at: number, ids: Set<string>) => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ at, ids: [...ids], key: o.cacheKey }), { mode: 0o600 });
    await rename(tmp, file);
  };

  /** Never rejects; parallel callers share one fetch. */
  const refresh = (): Promise<void> =>
    (inflight ??= (async () => {
      const ids = await list().catch(() => undefined);
      if (!ids) {
        failures++;
        retryAt = now() + Math.min(max, base * 2 ** Math.min(failures - 1, 20));
        return;
      }
      failures = 0;
      retryAt = 0;
      good = { at: now(), ids: new Set(ids) };
      if (o.cacheFile) await persist(o.cacheFile, good.at, good.ids).catch(() => undefined);
    })().finally(() => {
      inflight = undefined;
    }));

  const usable = (allowStale: boolean) => {
    if (!good) return undefined;
    const age = now() - good.at;
    return age <= ttl || (allowStale && age <= stale) ? good.ids : undefined;
  };

  const unavailable = (model: string) =>
    new FactoryToolingError(
      `cannot verify model ${model}: gateway unavailable (GET /v1/models did not answer and no model list from the last ${Math.round(stale / HOUR_MS)} h is cached)`,
    );

  /** Verdict on `model`; `blocking` lets the caller await a needed gateway fetch. */
  async function verdict(model: string, blocking: boolean): Promise<void> {
    await load();
    const cached = usable(true);
    const fresh = usable(false);
    if (cached?.has(model)) {
      // Stale but usable: answer now, revalidate in the background (unless backing off).
      if (!fresh && !inflight && now() >= retryAt) void refresh();
      return;
    }
    // A fresh list is authoritative until its TTL: no refetch per call for an unserved id.
    if (fresh) throw new Error(`model ${model} is not served by the gateway (GET /v1/models)`);
    // Unknown id on an old list, or no usable list: ask the gateway (backoff short-circuits).
    const pending = inflight ?? (now() >= retryAt ? refresh() : undefined);
    if (!blocking || !pending) throw unavailable(model);
    await pending;
    const ids = usable(true);
    if (ids?.has(model)) return;
    // Missing from an old list may just be a newly added model: unverifiable, not refused.
    if (!ids || !usable(false)) throw unavailable(model);
    throw new Error(`model ${model} is not served by the gateway (GET /v1/models)`);
  }

  return {
    /** Phase start: may wait for one gateway fetch when nothing usable is cached. */
    assert: (model: string) => verdict(model, true),
    /**
     * Dispatch preflight, never waits on the gateway (the tick loop is serial): the reason a model
     * phase should wait, or null to go ahead. A needed fetch runs in the background.
     */
    async ready(model: string): Promise<string | null> {
      try {
        await verdict(model, false);
        return null;
      } catch (error) {
        // An unserved id is a configuration error the phase reports; only outages wait.
        return error instanceof FactoryToolingError ? error.message : null;
      }
    },
  };
}
