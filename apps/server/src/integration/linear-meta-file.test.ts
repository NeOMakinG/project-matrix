import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearTicketStore } from "@matrix/tickets/adapters/linear";
import { expect, test } from "vitest";
import { LinearTickets } from "../http/schemas.js";
import { PrivateStateOwner } from "../state-owner.js";
import { PrivateLinearMetaStore } from "./linear-meta-file.js";
import { ticketStoreFor } from "./tickets.js";

test("per-project Linear meta persists privately and survives a reload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "matrix-linear-meta-"));
  const owner = new PrivateStateOwner(directory);
  try {
    const a = new PrivateLinearMetaStore(owner, "../evil/project");
    a.set("uuid-1", { phase: "review", blocked: true, blockedIn: "Ready" });
    a.set("../bad", { phase: "x" });
    const b = new PrivateLinearMetaStore(owner, "../evil/project");
    expect(b.get("uuid-1")).toEqual({ phase: "review", blocked: true, blockedIn: "Ready" });
    expect(b.get("../bad")).toBeUndefined();
    const files = readdirSync(owner.directory).filter((f) => f.startsWith("linear-meta-"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("/");
    expect(statSync(join(owner.directory, files[0] as string)).mode & 0o777).toBe(0o600);
    // Another project gets its own file.
    expect(new PrivateLinearMetaStore(owner, "other").get("uuid-1")).toBeUndefined();
  } finally {
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("linear app mode resolves from settings by env var NAME only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "matrix-linear-app-"));
  const owner = new PrivateStateOwner(directory);
  try {
    const store = ticketStoreFor(
      "/tmp/none",
      {
        kind: "linear",
        linear: {
          teamKey: "NEO",
          projectLabel: "project:demo",
          app: {
            clientIdEnv: "MATRIX_TEST_LINEAR_ID",
            clientSecretEnv: "MATRIX_TEST_LINEAR_SECRET",
          },
        },
      },
      {},
      owner,
      "demo",
    ) as LinearTicketStore;
    expect(store.appMode).toBe(true);
  } finally {
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  }
  const app = { clientIdEnv: "LINEAR_MATRIX_APP_CLIENT_ID", clientSecretEnv: "lin_oauth_x" };
  expect(LinearTickets.safeParse({ teamKey: "NEO", projectLabel: "p", app }).success).toBe(false);
  const ok = {
    clientIdEnv: "LINEAR_MATRIX_APP_CLIENT_ID",
    clientSecretEnv: "LINEAR_MATRIX_APP_CLIENT_SECRET",
  };
  expect(LinearTickets.safeParse({ teamKey: "NEO", projectLabel: "p", app: ok }).success).toBe(
    true,
  );
  expect(
    LinearTickets.safeParse({ teamKey: "NEO", projectLabel: "p", app: { ...ok, extra: 1 } })
      .success,
  ).toBe(false);
});
