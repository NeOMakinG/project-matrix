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

test("ids stay monotonic after a ticket file is deleted, and parallel creates never collide", async () => {
  const { rm, readdir } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "tickets-"));
  const store = new MarkdownTicketStore(dir);
  const a = await store.create({ title: "A", body: "" });
  const b = await store.create({ title: "B", body: "" });
  const file = (await readdir(dir)).find((f) => f.startsWith(b.id));
  await rm(join(dir, file as string));
  const c = await store.create({ title: "C", body: "" });
  expect([a.id, b.id, c.id]).toEqual(["T-0001", "T-0002", "T-0003"]);
  const many = await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.create({ title: `P${i}`, body: "" })),
  );
  expect(new Set(many.map((t) => t.id)).size).toBe(8);
});
