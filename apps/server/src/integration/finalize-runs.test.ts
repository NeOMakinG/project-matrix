import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleAnswers } from "@matrix/packs";
import { expect, test, vi } from "vitest";
import { createServer } from "../http/app.js";
import { createFactory } from "./factory.js";

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const trackers: ("markdown" | "beads")[] = ["markdown"];
if (process.env.MATRIX_TEST_BD_BINARY) trackers.push("beads");

test.each(trackers)(
  "%s: runs and overview settle after real finalize with a stalled tracker",
  async (kind) => {
    const factory = await createFactory({
      runtime: "fake",
      dataDir: mkdtempSync(join(tmpdir(), "matrix-finalize-runs-")),
      host: "test-host",
      log: () => undefined,
      ...(process.env.MATRIX_TEST_BD_BINARY
        ? { binaries: { bd: process.env.MATRIX_TEST_BD_BINARY } }
        : {}),
    });
    const server = createServer({ core: factory.core });
    const { token } = server.keys.create({
      name: "test",
      scope: { projects: "*", actions: ["admin"] },
    });
    const call = async (method: string, path: string, body?: unknown) =>
      server.app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      expect(await bounded(factory.core.listRuns(), "fresh listRuns")).toEqual([]);
      expect((await bounded(call("GET", "/v1/overview"), "fresh overview")).status).toBe(200);
      const created = await call("POST", "/v1/projects", {
        name: "repro",
        description: "",
        workspace: "native",
        tickets: { kind },
      });
      expect(created.status).toBe(200);
      const project = (await created.json()) as { id: string };
      const session = (await (
        await call("POST", `/v1/projects/${project.id}/init`, {})
      ).json()) as {
        id: string;
      };
      expect(
        (await call("POST", `/v1/init/${session.id}/answers`, { answers: sampleAnswers })).status,
      ).toBe(200);
      const finalized = await call("POST", `/v1/init/${session.id}/finalize`, {
        acceptRecommended: true,
      });
      expect(await finalized.json()).toMatchObject({
        state: "completed",
        result: { status: "ok" },
      });
      await bounded(factory.reconciler.tick(), "tick");
      await bounded(factory.reconciler.idle(), "idle", kind === "beads" ? 60_000 : 2_000);
      const records = await bounded(factory.store.listRuns(), "raw runs");
      expect(records.length).toBeGreaterThan(0);
      await factory.store.createApproval({
        id: "pending-approval",
        projectId: project.id,
        ticketId: records[0]!.ticketId,
        phase: records[0]!.phase,
        runId: records[0]!.id,
        headSha: "fixture-sha",
        requestedBy: records[0]!.ownerId,
        status: "pending",
        requestedAt: new Date(),
      });
      const tracker = await factory.core.ticketStore(project.id);
      const ticket = await tracker.get(records[0]!.ticketId);
      expect(ticket).not.toBeNull();
      const get = vi.spyOn(tracker, "get").mockImplementation(() => new Promise(() => {}));
      const runs = await bounded(factory.core.listRuns(), "listRuns");
      const [response, overview] = await bounded(
        Promise.all([call("GET", "/v1/runs"), call("GET", "/v1/overview")]),
        "run reads",
      );
      expect(runs).toHaveLength(records.length);
      expect(runs[0]?.title).toBe(ticket?.title);
      expect(runs[0]?.state).toBe("awaiting_approval");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([{ title: ticket?.title }]);
      expect(overview.status).toBe(200);
      expect(await overview.json()).toMatchObject({ activeRuns: 1, pendingApprovals: 1 });
      expect((await bounded(factory.core.getRun(records[0]!.id), "getRun"))?.title).toBe(
        ticket?.title,
      );
      const title = vi.spyOn(factory.store, "getIndexedTicketTitle").mockResolvedValue(null);
      expect(
        await bounded(factory.core.getRun(records[0]!.id), "unindexed getRun"),
      ).not.toHaveProperty("title");
      title.mockRestore();
      expect(get).not.toHaveBeenCalled();
      get.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await server.close();
      await factory.stop();
    }
  },
  120_000,
);
