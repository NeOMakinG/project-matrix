import { join } from "node:path";
import type { TicketStore } from "@matrix/tickets";
import { MarkdownTicketStore } from "@matrix/tickets/adapters/markdown";

export type TicketSystem = "beads" | "markdown" | "github";

export interface TicketSettings {
  kind: TicketSystem;
  /** GitHub `owner/name`, for the github adapter. */
  repo?: string;
}

export class TicketAdapterUnavailableError extends Error {}

/**
 * Picks the ticket adapter a project chose at init. Markdown lives in `.matrix/tickets` inside the
 * project repo. beads and GitHub adapters ship with the runtime packages (PR #4); until then they're
 * refused explicitly instead of silently falling back to another tracker.
 */
export function ticketStoreFor(repoPath: string, settings: TicketSettings): TicketStore {
  switch (settings.kind) {
    case "markdown":
      return new MarkdownTicketStore(join(repoPath, ".matrix", "tickets"), { root: repoPath });
    case "beads":
    case "github":
      throw new TicketAdapterUnavailableError(
        `the ${settings.kind} ticket adapter ships with the runtime packages (PR #4); use markdown for now`,
      );
  }
}

/** beads is the default once its adapter is available; markdown until then. */
export const DEFAULT_TICKETS: TicketSettings = { kind: "markdown" };
