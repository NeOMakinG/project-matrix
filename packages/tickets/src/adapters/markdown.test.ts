import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MarkdownTicketStore } from "./markdown";

test("create, link, ready and update round-trip through markdown files", async () => {
  const store = new MarkdownTicketStore(await mkdtemp(join(tmpdir(), "tickets-")));
  const a = await store.create({
    title: "Set up CI",
    body: "Add the check workflow.",
    labels: ["setup"],
  });
  const b = await store.create({ title: "Invoices: create invoice", body: "First feature." });
  await store.link(b.id, a.id, "blocks");
  expect((await store.ready()).map((t) => t.id)).toEqual([a.id]);
  await store.update(a.id, { status: "done" });
  expect((await store.ready()).map((t) => t.id)).toEqual([b.id]);
  await store.comment(b.id, "Spike done.");
  const again = await store.get(b.id);
  expect(again?.deps).toEqual([a.id]);
  expect(again?.body).toContain("Spike done.");
  expect(await store.list({ labels: ["setup"] })).toHaveLength(1);
});
