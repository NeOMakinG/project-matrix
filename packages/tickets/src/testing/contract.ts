import { expect, test } from "vitest";
import type { TicketStore } from "../types.js";

/** Behaviour every TicketStore adapter must share. */
export function ticketStoreContract(
  name: string,
  make: () => Promise<TicketStore>,
  timeoutMs = 5_000,
): void {
  test(
    `${name}: create, get and list`,
    async () => {
      const store = await make();
      const a = await store.create({
        title: "Alpha",
        body: "first\nline",
        labels: ["web"],
        priority: 1,
      });
      expect(a).toMatchObject({ title: "Alpha", body: "first\nline", status: "open", priority: 1 });
      expect(a.labels).toEqual(["web"]);
      expect((await store.get(a.id))?.title).toBe("Alpha");
      expect((await store.list()).map((t) => t.id)).toContain(a.id);
      expect((await store.list({ labels: ["web"] })).map((t) => t.id)).toEqual([a.id]);
      expect(await store.get("999999")).toBeNull();
    },
    timeoutMs,
  );

  test(
    `${name}: status, phase and label updates round-trip`,
    async () => {
      const store = await make();
      const a = await store.create({ title: "Beta", body: "b" });
      const qa = await store.update(a.id, { status: "qa", phase: "qa", labels: ["x"] });
      expect(qa).toMatchObject({ status: "qa", phase: "qa", labels: ["x"] });
      expect((await store.list({ status: ["qa"] })).map((t) => t.id)).toEqual([a.id]);
      const done = await store.update(a.id, { status: "done", body: "updated" });
      expect(done).toMatchObject({ status: "done", body: "updated" });
    },
    timeoutMs,
  );

  test(
    `${name}: dependencies gate readiness`,
    async () => {
      const store = await make();
      const blocker = await store.create({ title: "Blocker", body: "" });
      const blocked = await store.create({ title: "Blocked", body: "" });
      await store.link(blocker.id, blocked.id, "blocks");
      expect((await store.get(blocked.id))?.deps).toEqual([blocker.id]);
      let ready = (await store.ready()).map((t) => t.id);
      expect(ready).toContain(blocker.id);
      expect(ready).not.toContain(blocked.id);
      await store.update(blocker.id, { status: "done" });
      ready = (await store.ready()).map((t) => t.id);
      expect(ready).toContain(blocked.id);
    },
    timeoutMs,
  );

  test(
    `${name}: comments and parents`,
    async () => {
      const store = await make();
      const epic = await store.create({ title: "Epic", body: "" });
      const child = await store.create({ title: "Child", body: "" });
      await store.link(epic.id, child.id, "parent");
      expect((await store.get(child.id))?.parent).toBe(epic.id);
      await expect(store.comment(child.id, "note")).resolves.toBeUndefined();
    },
    timeoutMs,
  );
}
