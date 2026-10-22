import type { TicketStore } from "@matrix/tickets";

/**
 * The store phase handlers see: reads and creates behave as usual, but comments are best effort,
 * so a tracker outage while posting a plan never fails the phase. Failures go to `onFailure`.
 */
export function bestEffortComments(
  store: TicketStore,
  onFailure: (ticketId: string, operation: string, error: unknown) => void,
): TicketStore {
  return {
    kind: store.kind,
    list: (query) => store.list(query),
    get: (id) => store.get(id),
    create: (input) => store.create(input),
    update: (id, patch) => store.update(id, patch),
    link: (from, to, type) => store.link(from, to, type),
    ready: () => store.ready(),
    comment: async (id, body) => {
      try {
        await store.comment(id, body);
      } catch (error) {
        onFailure(id, "comment", error);
      }
    },
  };
}
