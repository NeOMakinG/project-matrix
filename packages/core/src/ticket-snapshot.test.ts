import type { Ticket } from "@matrix/tickets";
import { expect, test } from "vitest";
import { MemoryStore } from "./store.js";

const ticket: Ticket = {
  id: "T-1",
  title: "Historical",
  body: "",
  status: "open",
  labels: [],
  deps: [],
  createdAt: "2026-10-13",
  updatedAt: "2026-10-13",
};

test("memory snapshot replacement preserves historical titles and other projects", async () => {
  const store = new MemoryStore();
  await store.replaceIndexedTickets("first", [ticket]);
  await store.replaceIndexedTickets("other", [ticket]);
  await store.replaceIndexedTickets("first", []);
  expect(await store.listIndexedTickets("first")).toEqual([]);
  expect(await store.getIndexedTicket("first", ticket.id)).toBeNull();
  expect(await store.getIndexedTicketTitle("first", ticket.id)).toBe("Historical");
  expect(await store.listIndexedTickets("other")).toEqual([ticket]);
});

test("memory replacement prepares every snapshot before changing membership", async () => {
  const store = new MemoryStore();
  await store.replaceIndexedTickets("first", [ticket]);
  const invalid = { ...ticket, id: "T-2", body: () => {} } as unknown as Ticket;
  await expect(
    store.replaceIndexedTickets("first", [{ ...ticket, title: "New" }, invalid]),
  ).rejects.toThrow();
  expect(await store.listIndexedTickets("first")).toEqual([ticket]);
  const controller = new AbortController();
  controller.abort(new Error("expired"));
  await expect(store.replaceIndexedTickets("first", [], controller.signal)).rejects.toThrow(
    "expired",
  );
  expect(await store.listIndexedTickets("first")).toEqual([ticket]);
});
