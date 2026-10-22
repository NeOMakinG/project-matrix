import { expect, test } from "vitest";
import { LinearTicketStore } from "./linear";

/**
 * Opt-in, read-only smoke test against the real Linear API. Skipped unless
 * `MATRIX_LINEAR_LIVE=1` and `LINEAR_API_KEY` are set on the host. Never mutates.
 */
const live = process.env.MATRIX_LINEAR_LIVE === "1" && !!process.env.LINEAR_API_KEY;

test.skipIf(!live)(
  "linear live: list and ready are read-only and scoped",
  async () => {
    const store = new LinearTicketStore({
      teamKey: process.env.MATRIX_LINEAR_TEAM ?? "NEO",
      projectLabel: process.env.MATRIX_LINEAR_LABEL ?? "project:personal",
    });
    const all = await store.list();
    for (const t of all) expect(t.id).toMatch(/^[A-Z][A-Z0-9]*-\d+$/);
    const ready = await store.ready();
    for (const t of ready) expect(all.map((a) => a.id)).toContain(t.id);
  },
  30_000,
);
