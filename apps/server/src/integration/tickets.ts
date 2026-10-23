import { join } from "node:path";
import { hostExecutor, type LineExecutor } from "@matrix/sandbox";
import type { TicketStore } from "@matrix/tickets";
import { BeadsStore } from "@matrix/tickets/adapters/beads";
import { BeadsQueueTimeoutError } from "@matrix/tickets/adapters/beads-queue";
import { GitHubStore } from "@matrix/tickets/adapters/github";
import { LinearTicketStore } from "@matrix/tickets/adapters/linear";
import { MarkdownTicketStore } from "@matrix/tickets/adapters/markdown";
import { CoreError } from "../core-port.js";
import type { PrivateStateOwner } from "../state-owner.js";
import { linearTokenCacheFile, PrivateLinearMetaStore } from "./linear-meta-file.js";
import { publishOwnedFile } from "./owned-files.js";

export type TicketSystem = "beads" | "markdown" | "github" | "linear";

export interface TicketSettings {
  kind: TicketSystem;
  /** GitHub `owner/name`, for the github adapter. */
  repo?: string;
  /** Linear team + project label, for the linear adapter. The API key stays in the host env. */
  linear?: {
    teamKey: string;
    projectLabel: string;
    readyState?: string;
    /** Host env var NAME holding the key (default `LINEAR_API_KEY`). Never the key itself. */
    apiKeyEnv?: string;
    /**
     * OAuth app (client credentials): host env var NAMES of the client id and secret. When set,
     * Matrix acts as its own Linear app user and `apiKeyEnv` is ignored.
     */
    app?: { clientIdEnv: string; clientSecretEnv: string };
  };
}

export interface TicketBinaries {
  bd?: string;
  gh?: string;
}

export class TrackerTimeoutError extends Error {
  constructor() {
    super("tracker timed out");
    this.name = "TrackerTimeoutError";
  }
}

export async function trackerDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    if (signal?.aborted) throw signal.reason;
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        abort = () => {
          controller.abort(signal?.reason);
          reject(signal?.reason ?? new Error("tracker cancelled"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          controller.abort(new TrackerTimeoutError());
          reject(controller.signal.reason);
        }, timeoutMs);
      }),
      operation(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

/**
 * Picks the ticket adapter a project chose at init: beads (default, `.beads` in the project repo),
 * markdown (`.matrix/tickets` in the repo), GitHub Issues or Linear (host-only API key).
 */
export function ticketStoreFor(
  repoPath: string,
  settings: TicketSettings,
  binaries: TicketBinaries = {},
  owner?: PrivateStateOwner,
  projectId?: string,
): TicketStore {
  const executor: LineExecutor = (spec, onLine, signal) =>
    trackerDeadline(
      (boundedSignal) => hostExecutor(spec, onLine, boundedSignal),
      owner ? AbortSignal.any([signal, owner.signal]) : signal,
      Math.min(spec.timeoutMs, 10_000),
    );
  switch (settings.kind) {
    case "markdown":
      return new MarkdownTicketStore(join(repoPath, ".matrix", "tickets"), {
        root: repoPath,
        ...(owner ? { publish: (input) => publishOwnedFile({ ...input, owner }) } : {}),
      });
    case "beads":
      const beads = new BeadsStore({
        cwd: repoPath,
        executor: async (spec, onLine, signal) => {
          const result = await hostExecutor(
            spec,
            onLine,
            owner ? AbortSignal.any([signal, owner.signal]) : signal,
          );
          if (result.timedOut) throw new TrackerTimeoutError();
          if (result.cancelled) throw owner?.signal.reason ?? new Error("tracker cancelled");
          return result;
        },
        ...(owner ? { signal: owner.signal } : {}),
        ...(binaries.bd ? { bdBinary: binaries.bd } : {}),
      });
      return new Proxy(beads, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            try {
              return await value.apply(target, args);
            } catch (error) {
              if (error instanceof BeadsQueueTimeoutError || error instanceof TrackerTimeoutError)
                throw new CoreError("tracker_unavailable", error.message);
              throw error;
            }
          };
        },
      });
    case "github":
      if (!settings.repo) throw new Error("the github ticket adapter needs `repo` (owner/name)");
      return new GitHubStore({
        repo: settings.repo,
        cwd: repoPath,
        executor,
        ...(binaries.gh ? { ghBinary: binaries.gh } : {}),
      });
    case "linear": {
      const linear = settings.linear;
      if (!linear)
        throw new Error("the linear ticket adapter needs `linear` (teamKey, projectLabel)");
      return new LinearTicketStore({
        teamKey: linear.teamKey,
        projectLabel: linear.projectLabel,
        ...(linear.readyState ? { readyState: linear.readyState } : {}),
        ...(linear.apiKeyEnv ? { apiKeyEnv: linear.apiKeyEnv } : {}),
        ...(linear.app
          ? {
              app: {
                clientIdEnv: linear.app.clientIdEnv,
                clientSecretEnv: linear.app.clientSecretEnv,
              },
              ...(owner
                ? { tokenCacheFile: linearTokenCacheFile(owner, linear.app.clientIdEnv) }
                : {}),
            }
          : {}),
        // Matrix's per-issue meta stays host-side (never in issue descriptions) when owned.
        ...(owner && projectId ? { metaStore: new PrivateLinearMetaStore(owner, projectId) } : {}),
        ...(owner ? { signal: owner.signal } : {}),
      });
    }
  }
}

export const DEFAULT_TICKETS: TicketSettings = { kind: "beads" };
