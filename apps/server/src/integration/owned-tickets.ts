import { createHash } from "node:crypto";
import type { NewTicket, TicketStore } from "@matrix/tickets";
import { PrivateState } from "../private-state.js";
import type { PrivateStateOwner } from "../state-owner.js";

export function ownedExternalTickets(
  store: TicketStore,
  owner: PrivateStateOwner,
  file: string,
): TicketStore {
  const state = new PrivateState<Record<string, { id?: string }>>(file, owner);
  const create = async (input: NewTicket) => {
    owner.assertOwned();
    const identity =
      input.labels?.find((label) => label.startsWith("fp:")) ??
      /Watch id: (\S+)/.exec(input.body)?.[1];
    if (!identity) throw new Error("external create requires a stable reconciliation identity");
    const digest = createHash("sha256").update(identity).digest("hex");
    const marker = `<!-- matrix-external-ticket:${digest} -->`;
    const prior = state.load({})[digest];
    if (prior) {
      const matches = (await owner.guard(() => store.list())).filter((ticket) =>
        ticket.body.includes(marker),
      );
      if (matches.length !== 1 || (prior.id && matches[0]!.id !== prior.id))
        throw new Error("external create outcome unknown; reconcile marker before retrying");
      const ticket = matches[0]!;
      state.save({ ...state.load({}), [digest]: { id: ticket.id } });
      return ticket;
    }
    state.save({ ...state.load({}), [digest]: {} });
    try {
      const ticket = await owner.guard(() =>
        store.create({ ...input, body: `${input.body}\n\n${marker}` }),
      );
      owner.assertOwned();
      state.save({ ...state.load({}), [digest]: { id: ticket.id } });
      return ticket;
    } catch (cause) {
      throw new Error("external create outcome unknown; reconcile marker before retrying", {
        cause,
      });
    }
  };
  return owner.fence(
    new Proxy(store, {
      get: (target, key) => {
        if (key === "create") return create;
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
}
