import { join } from "node:path";
import type { TicketStore } from "@matrix/tickets";
import { BeadsStore } from "@matrix/tickets/adapters/beads";
import { GitHubStore } from "@matrix/tickets/adapters/github";
import { MarkdownTicketStore } from "@matrix/tickets/adapters/markdown";
import type { PrivateStateOwner } from "../state-owner.js";
import { publishOwnedFile } from "./owned-files.js";

export type TicketSystem = "beads" | "markdown" | "github";

export interface TicketSettings {
  kind: TicketSystem;
  /** GitHub `owner/name`, for the github adapter. */
  repo?: string;
}

export interface TicketBinaries {
  bd?: string;
  gh?: string;
}

/**
 * Picks the ticket adapter a project chose at init: beads (default, `.beads` in the project repo),
 * markdown (`.matrix/tickets` in the repo) or GitHub Issues.
 */
export function ticketStoreFor(
  repoPath: string,
  settings: TicketSettings,
  binaries: TicketBinaries = {},
  owner?: PrivateStateOwner,
): TicketStore {
  switch (settings.kind) {
    case "markdown":
      return new MarkdownTicketStore(join(repoPath, ".matrix", "tickets"), {
        root: repoPath,
        ...(owner ? { publish: (input) => publishOwnedFile({ ...input, owner }) } : {}),
      });
    case "beads":
      return new BeadsStore({ cwd: repoPath, ...(binaries.bd ? { bdBinary: binaries.bd } : {}) });
    case "github":
      if (!settings.repo) throw new Error("the github ticket adapter needs `repo` (owner/name)");
      return new GitHubStore({
        repo: settings.repo,
        cwd: repoPath,
        ...(binaries.gh ? { ghBinary: binaries.gh } : {}),
      });
  }
}

export const DEFAULT_TICKETS: TicketSettings = { kind: "beads" };
