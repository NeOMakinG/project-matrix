import type { TicketStore } from "@matrix/tickets";
import { expect, test } from "vitest";
import { lazyTickets } from "./factory.js";

test("the reconciler's lazy ticket store forwards uploadFile (agent QA screenshots)", async () => {
  const calls: string[] = [];
  const store = lazyTickets(
    async () =>
      ({
        uploadFile: async (id: string, name: string) => {
          calls.push(`${id}/${name}`);
          return `https://uploads.linear.app/${name}`;
        },
      }) as unknown as TicketStore,
  );
  expect(await store.uploadFile?.("NEO-8", "s1.png", "image/png", new Uint8Array([1]))).toBe(
    "https://uploads.linear.app/s1.png",
  );
  expect(calls).toEqual(["NEO-8/s1.png"]);
  const none = lazyTickets(async () => ({}) as TicketStore);
  expect(await none.uploadFile?.("NEO-8", "s1.png", "image/png", new Uint8Array())).toBe("");
});
