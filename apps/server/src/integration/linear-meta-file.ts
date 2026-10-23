import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LinearMetaStore } from "@matrix/tickets/adapters/linear";
import { type LinearMeta, safeMeta } from "@matrix/tickets/adapters/linear-mapping";
import { PrivateState } from "../private-state.js";
import type { PrivateStateOwner } from "../state-owner.js";

/** File-safe name for a project id (ids are user-chosen: never trust them as path parts). */
function fileName(projectId: string): string {
  const slug = projectId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  const hash = createHash("sha256").update(projectId).digest("hex").slice(0, 12);
  return `${slug || "project"}-${hash}.json`;
}

/**
 * Matrix's per-issue Linear meta for one project, kept in the owned private state directory
 * (mode 600, atomic writes), keyed by Linear issue UUID. Values are re-validated on load.
 */
export class PrivateLinearMetaStore implements LinearMetaStore {
  readonly #state: PrivateState<Record<string, unknown>>;
  #cache: Map<string, LinearMeta> | undefined;

  constructor(owner: PrivateStateOwner, projectId: string) {
    this.#state = new PrivateState(
      join(owner.directory, `linear-meta-${fileName(projectId)}`),
      owner,
    );
  }

  #load(): Map<string, LinearMeta> {
    if (this.#cache) return this.#cache;
    const raw = this.#state.load({});
    const map = new Map<string, LinearMeta>();
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      for (const [id, value] of Object.entries(raw))
        if (/^[A-Za-z0-9-]{1,64}$/.test(id) && value && typeof value === "object")
          map.set(id, safeMeta(value as Record<string, unknown>));
    this.#cache = map;
    return map;
  }

  get(issueUuid: string): LinearMeta | undefined {
    const value = this.#load().get(issueUuid);
    return value ? structuredClone(value) : undefined;
  }

  set(issueUuid: string, meta: LinearMeta): void {
    const map = this.#load();
    const next = new Map(map);
    next.set(issueUuid, safeMeta(meta as Record<string, unknown>));
    this.#state.save(Object.fromEntries(next));
    this.#cache = next;
  }
}

/** Token cache path for one OAuth app, inside the owned private state directory. */
export function linearTokenCacheFile(owner: PrivateStateOwner, clientIdEnv: string): string {
  return join(owner.directory, `linear-app-token-${clientIdEnv.toLowerCase()}.json`);
}
