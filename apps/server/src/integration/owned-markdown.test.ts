import { type ChildProcess, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TicketStore } from "@matrix/tickets";
import { MarkdownTicketStore } from "@matrix/tickets/adapters/markdown";
import * as safeFiles from "@matrix/tickets/adapters/safe-fs";
import { afterEach, expect, test, vi } from "vitest";
import { PrivateStateOwner } from "../state-owner.js";
import { createFactory } from "./factory.js";
import { publishOwnedFile } from "./owned-files.js";
import { ticketStoreFor } from "./tickets.js";

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function replaceGuardian(owner: PrivateStateOwner) {
  const child = Reflect.get(owner, "child") as ChildProcess;
  expect(child.kill("SIGKILL")).toBe(true);
  spawnSync("sleep", ["0.05"]);
  const next = new PrivateStateOwner(owner.directory);
  expect(() => owner.assertOwned()).toThrow("ownership lost");
  return next;
}

function snapshot(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".state-owner")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [child, content] of Object.entries(snapshot(path)))
        result[join(entry.name, child)] = content;
    } else result[entry.name] = readFileSync(path, "utf8");
  }
  return result;
}

const mutations: Record<string, (store: TicketStore, id: string) => Promise<unknown>> = {
  update: (store, id) => store.update(id, { body: "obsolete" }),
  comment: (store, id) => store.comment(id, "obsolete"),
  blocks: (store, id) => store.link(id, "T-9999", "blocks"),
  parent: (store, id) => store.link(id, "T-9999", "parent"),
  related: (store, id) => store.link(id, "T-9999", "related"),
};

test.each(Object.keys(mutations))(
  "real Markdown %s cannot publish a deferred read after guardian replacement",
  async (method) => {
    const root = mkdtempSync(join(tmpdir(), "matrix-owned-markdown-"));
    const owner = new PrivateStateOwner(root);
    const store = ticketStoreFor(root, { kind: "markdown" }, {}, owner);
    const entered = deferred();
    const resume = deferred();
    let next: PrivateStateOwner | undefined;
    try {
      const ticket = await store.create({ title: "original", body: "original" });
      const originalRead = safeFiles.readFileSafe;
      let reads = 0;
      vi.spyOn(safeFiles, "readFileSafe").mockImplementation(async (directory, path) => {
        const text = await originalRead(directory, path);
        if (++reads === (method === "update" ? 1 : 2)) {
          entered.resolve();
          await resume.promise;
        }
        return text;
      });
      const pending = mutations[method]!(store, ticket.id);
      const rejected = expect(pending).rejects.toThrow("ownership lost");
      await entered.promise;
      next = replaceGuardian(owner);
      const replacement = ticketStoreFor(root, { kind: "markdown" }, {}, next);
      await replacement.update(ticket.id, { body: "new owner canonical" });
      const before = snapshot(root);
      resume.resolve();
      await rejected;
      expect(snapshot(root)).toEqual(before);
      expect((await replacement.get(ticket.id))?.body).toBe("new owner canonical");
    } finally {
      resume.resolve();
      await owner.close();
      await next?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("guardian replacement during ID enumeration cannot reserve an ID or create directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "matrix-owned-id-"));
  const owner = new PrivateStateOwner(root);
  const entered = deferred();
  const resume = deferred();
  let next: PrivateStateOwner | undefined;
  try {
    const originalCheck = safeFiles.assertSafePath;
    vi.spyOn(safeFiles, "assertSafePath").mockImplementation(async (directory, path) => {
      await originalCheck(directory, path);
      if (path.endsWith(".ids")) {
        entered.resolve();
        await resume.promise;
      }
    });
    const store = ticketStoreFor(root, { kind: "markdown" }, {}, owner);
    const pending = store.create({ title: "obsolete", body: "" });
    const rejected = expect(pending).rejects.toThrow("ownership lost");
    await entered.promise;
    next = replaceGuardian(owner);
    const before = snapshot(root);
    resume.resolve();
    await rejected;
    expect(snapshot(root)).toEqual(before);
  } finally {
    resume.resolve();
    await owner.close();
    await next?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ticket creation rechecks publication after a valid ID reservation", async () => {
  const root = mkdtempSync(join(tmpdir(), "matrix-owned-create-"));
  const owner = new PrivateStateOwner(root);
  let next: PrivateStateOwner | undefined;
  let before: Record<string, string> | undefined;
  try {
    const store = new MarkdownTicketStore(join(root, "tickets"), {
      root,
      publish: (input) => publishOwnedFile({ ...input, owner }),
      now: () => {
        next = replaceGuardian(owner);
        before = snapshot(root);
        return new Date();
      },
    });
    await expect(store.create({ title: "obsolete", body: "" })).rejects.toThrow("ownership lost");
    expect(snapshot(root)).toEqual(before);
    expect(snapshot(root)).toEqual({ "tickets/.ids/T-0001": "" });
  } finally {
    await owner.close();
    await next?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("factory supplies owned publication; valid mutations and parallel reservations work", async () => {
  const root = mkdtempSync(join(tmpdir(), "matrix-factory-markdown-"));
  const factory = await createFactory({
    runtime: "fake",
    dataDir: root,
    host: "test",
    log: () => {},
  });
  let next: PrivateStateOwner | undefined;
  try {
    const project = await factory.core.createProject({
      name: "markdown-fixture",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    });
    const store = await factory.core.ticketStore(project.id);
    const tickets = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.create({ title: `ticket-${index}`, body: "initial" }),
      ),
    );
    expect(new Set(tickets.map((ticket) => ticket.id)).size).toBe(8);
    for (const mutate of Object.values(mutations)) await mutate(store, tickets[0]!.id);
    const updated = await store.get(tickets[0]!.id);
    expect(updated?.body).toContain("Comment");
    expect(updated?.deps).toEqual(["T-9999"]);
    expect(updated?.parent).toBe("T-9999");
    expect(updated?.labels).toContain("related:T-9999");
    next = replaceGuardian(factory.stateOwner);
    const before = snapshot(root);
    await expect(store.create({ title: "obsolete", body: "" })).rejects.toThrow("ownership lost");
    for (const mutate of Object.values(mutations))
      await expect(mutate(store, tickets[0]!.id)).rejects.toThrow("ownership lost");
    expect(snapshot(root)).toEqual(before);
  } finally {
    await factory.stop();
    await next?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("factory Markdown continuation is fenced at publication, not just its outer raced promise", async () => {
  const root = mkdtempSync(join(tmpdir(), "matrix-factory-deferred-markdown-"));
  const factory = await createFactory({
    runtime: "fake",
    dataDir: root,
    host: "test",
    log: () => {},
  });
  const entered = deferred();
  const resume = deferred();
  let next: PrivateStateOwner | undefined;
  try {
    const project = await factory.core.createProject({
      name: "markdown-deferred-fixture",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    });
    const store = await factory.core.ticketStore(project.id);
    const ticket = await store.create({ title: "original", body: "canonical" });
    const originalRead = safeFiles.readFileSafe;
    vi.spyOn(safeFiles, "readFileSafe").mockImplementationOnce(async (directory, path) => {
      const text = await originalRead(directory, path);
      entered.resolve();
      await resume.promise;
      return text;
    });
    const pending = store.update(ticket.id, { body: "obsolete" });
    const rejected = expect(pending).rejects.toThrow("ownership lost");
    await entered.promise;
    next = replaceGuardian(factory.stateOwner);
    const before = snapshot(root);
    await rejected;
    resume.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(snapshot(root)).toEqual(before);
  } finally {
    resume.resolve();
    await factory.stop();
    await next?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("owned publication preserves exclusive creation, symlink refusal and stale-read rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "matrix-markdown-safety-"));
  const owner = new PrivateStateOwner(root);
  try {
    const store = ticketStoreFor(root, { kind: "markdown" }, {}, owner);
    const ticket = await store.create({ title: "original", body: "original" });
    const dir = join(root, ".matrix", "tickets");
    const path = join(dir, readdirSync(dir).find((name) => name.endsWith(".md"))!);
    const content = readFileSync(path, "utf8");
    expect(() => publishOwnedFile({ root, path, content, createOnly: true, owner })).toThrow(
      "already exists",
    );
    expect(() => publishOwnedFile({ root, path, content, previous: "stale", owner })).not.toThrow();
    expect(() =>
      publishOwnedFile({ root, path, content, previous: "stale", requireExisting: true, owner }),
    ).toThrow("changed");
    rmSync(path);
    expect(() =>
      publishOwnedFile({ root, path, content, previous: content, requireExisting: true, owner }),
    ).toThrow();
    const victim = join(root, "victim");
    writeFileSync(victim, "untouched");
    symlinkSync(victim, path);
    await expect(store.update(ticket.id, { body: "bad" })).rejects.toThrow("symlink");
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    rmSync(join(dir, ".ids"), { recursive: true });
    symlinkSync(root, join(dir, ".ids"));
    await expect(store.create({ title: "bad", body: "" })).rejects.toThrow("symlink");
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});
