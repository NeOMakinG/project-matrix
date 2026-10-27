import { OrcaCli, record, str } from "@matrix/workspace";
import type { OrcaCaller, OrcaRoute } from "./deploy-orca.js";
import { liveKey, liveRouteWorktrees, routeComment } from "./deploy-orca.js";

/** Throwaway route worktrees are named `mx-<label>-...` (deploy, run, probe, ...). */
export const ROUTE_NAME = /^mx-[a-z]{1,12}-[0-9a-z]{1,8}-[0-9a-f]{6}$/;

export interface ReapResult {
  removed: string[];
  kept: number;
  errors: string[];
}

/**
 * Removes Orca route worktrees (and their terminals) that no live run in this process owns and
 * that are older than `maxAgeMs`: what a server restart, crash or failed cleanup left behind on a
 * paired host. Only worktrees named like a route worktree (`mx-<label>-<id>-<nonce>`) are touched.
 */
export async function reapRouteWorktrees(o: {
  routes: OrcaRoute[];
  cli?: (environment: string) => OrcaCaller;
  binary?: string;
  now?: () => number;
  maxAgeMs?: number;
  live?: ReadonlySet<string>;
  /** Expected Orca comment (default: this server's routeComment()). */
  owner?: string;
}): Promise<ReapResult> {
  const now = (o.now ?? Date.now)();
  const maxAge = o.maxAgeMs ?? 30 * 60_000;
  const live = o.live ?? liveRouteWorktrees;
  const result: ReapResult = { removed: [], kept: 0, errors: [] };
  // Every repo on a routed host: a repo dropped from the config may still hold leftovers.
  for (const environment of new Set(o.routes.map((r) => r.environment))) {
    const cli =
      o.cli?.(environment) ??
      new OrcaCli({ environment, ...(o.binary ? { binary: o.binary } : {}) });
    let list: unknown[];
    try {
      const got = record(await cli.call(["worktree", "list", "--json"], 60_000));
      list = Array.isArray(got.worktrees) ? got.worktrees : Array.isArray(got) ? got : [];
    } catch (e) {
      result.errors.push(
        `${environment}: worktree list failed: ${(e as Error).message.slice(0, 120)}`,
      );
      continue;
    }
    for (const raw of list) {
      const w = record(raw);
      const path = str(w.path);
      const name = str(w.displayName) ?? path?.split("/").at(-1);
      if (!path || !name || !ROUTE_NAME.test(name) || w.isMainWorktree === true) continue;
      // Only worktrees this Matrix server created (another server's runs are not ours to judge).
      if (str(w.comment) !== (o.owner ?? routeComment())) continue;
      const created = Number(w.createdAt ?? w.lastActivityAt ?? 0);
      // Unknown or malformed age never authorizes a delete.
      if (
        live.has(liveKey(environment, path)) ||
        !Number.isFinite(created) ||
        created <= 0 ||
        now - created < maxAge
      ) {
        result.kept += 1;
        continue;
      }
      await cli
        .call(["terminal", "close", "--worktree", `path:${path}`, "--all", "--json"])
        .catch(() => undefined);
      try {
        await cli.call(
          ["worktree", "rm", "--worktree", `path:${path}`, "--force", "--json"],
          180_000,
        );
        result.removed.push(`${environment}:${path}`);
      } catch (e) {
        result.errors.push(`${environment}:${path}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }
  return result;
}
