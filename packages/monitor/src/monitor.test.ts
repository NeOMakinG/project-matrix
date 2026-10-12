import { describe, expect, test } from "vitest";
import otel from "./fixtures/otel-alertmanager.json";
import posthog from "./fixtures/posthog-exception.json";
import sentryEvent from "./fixtures/sentry-event.json";
import { MemoryIssueStore } from "./group.js";
import { Monitor } from "./monitor.js";
import { ticketBody } from "./policy.js";
import {
  FakeTicketStore,
  fakeGraph,
  QueueSource,
  RecordingNotifier,
  raw,
  ScriptedLlm,
  staticReleases,
} from "./testing.js";

const fixable = JSON.stringify({
  fixable: 0.82,
  category: "code",
  rootCause: "invoiceTotal reads line.amount on lines without a price.",
  rationale: "Deterministic null access at one in-app location.",
  suspectedFiles: ["src/billing/totals.ts"],
  reproSteps: ["Create an invoice with an unpriced line", "Open /invoices"],
});
const infra = JSON.stringify({
  fixable: 0.2,
  category: "infra",
  rootCause: "Upstream database saturation.",
  rationale: "Not a code change; needs capacity work.",
  suspectedFiles: [],
  reproSteps: [],
});

function setup(replies: string[], now = { value: "2026-10-12T10:30:00.000Z" }) {
  const source = new QueueSource();
  const store = new MemoryIssueStore();
  const tickets = new FakeTicketStore();
  const notifier = new RecordingNotifier();
  const llm = new ScriptedLlm(replies);
  const deployments = [
    { release: "web@1.3.0", deployedAt: "2026-10-10T10:00:00.000Z" },
    { release: "web@1.4.0", deployedAt: "2026-10-12T08:00:00.000Z" },
  ];
  const monitor = new Monitor({
    source,
    store,
    tickets,
    llm,
    graph: fakeGraph,
    releases: staticReleases(deployments),
    notifier,
    model: "gpt-6.1-sol",
    defaultProjectId: "ledgerly",
    clock: () => now.value,
  });
  return { source, store, tickets, notifier, llm, monitor, deployments, now };
}

describe("Monitor", () => {
  test("sentry + posthog of the same bug → one issue, one auto-fix ticket ready for the loop", async () => {
    const { source, tickets, monitor, llm } = setup([fixable]);
    source.queue = [
      raw("sentry", sentryEvent, "2026-10-12T10:13:21.000Z"),
      raw("posthog", posthog, "2026-10-12T10:14:00.000Z"),
    ];
    const r = await monitor.tick();
    expect(r).toMatchObject({ signals: 2, newIssues: 1 });
    expect(llm.requests).toHaveLength(1);
    expect(r.triaged[0]?.decision.action).toBe("auto-fix");

    const [ticket] = await tickets.list();
    // error (2) + regression in web@1.4.0 (1) = 3 → medium, priority 2
    expect(ticket).toMatchObject({ status: "ready", priority: 2 });
    expect(ticket?.labels).toEqual(["prod-fix", "auto-fix", "severity:medium"]);
    expect(ticket?.body).toContain("## Suspected files\n- src/billing/totals.ts");
    expect(ticket?.body).toContain("ADRs ADR-0007; features invoicing");
    expect(ticket?.body).toContain("1. Create an invoice with an unpriced line");
    expect(monitor.since).toBe("2026-10-12T10:14:00.000Z");
  });

  test("non-code issue → needs-human ticket + notification", async () => {
    const { source, tickets, notifier, monitor } = setup([infra]);
    source.queue = [raw("otel", otel)];
    const r = await monitor.tick();
    expect(r.triaged[0]?.decision.action).toBe("human");
    const [ticket] = await tickets.list();
    expect(ticket?.status).toBe("open");
    expect(ticket?.labels).toContain("needs-human");
    expect(notifier.sent[0]?.title).toContain("Needs a human");
  });

  test("repeat signals of a ticketed issue are not re-triaged and don't create tickets", async () => {
    const { source, tickets, monitor, llm } = setup([fixable]);
    source.queue = [raw("sentry", sentryEvent, "2026-10-12T10:13:21.000Z")];
    await monitor.tick();
    const again = {
      ...sentryEvent,
      data: { event: { ...sentryEvent.data.event, event_id: "e2" } },
    };
    source.queue = [raw("sentry", again, "2026-10-12T10:20:00.000Z")];
    const r = await monitor.tick();
    expect(r.triaged).toHaveLength(0);
    expect(llm.requests).toHaveLength(1);
    expect(await tickets.list()).toHaveLength(1);
  });

  test("fix deployed + quiet window → ticket done; recurrence reopens the same ticket", async () => {
    const { source, store, tickets, monitor, deployments, now } = setup([fixable, fixable]);
    source.queue = [raw("sentry", sentryEvent, "2026-10-12T10:13:21.000Z")];
    const first = await monitor.tick();
    const fp = first.triaged[0]?.issue.fingerprint ?? "";
    const ticketId = first.triaged[0]?.issue.ticketId ?? "";

    deployments.push({ release: "web@1.4.1", deployedAt: "2026-10-12T11:00:00.000Z" });
    await monitor.markFixDeployed(fp, "web@1.4.1");

    now.value = "2026-10-12T13:00:00.000Z";
    expect((await monitor.verify())[0]?.result.outcome).toBe("pending");

    now.value = "2026-10-12T17:30:00.000Z";
    const [done] = await monitor.verify();
    expect(done?.result.outcome).toBe("resolved");
    expect((await tickets.get(ticketId))?.status).toBe("done");
    expect((await store.get(fp))?.status).toBe("resolved");

    const back = {
      ...sentryEvent,
      data: { event: { ...sentryEvent.data.event, event_id: "e3", timestamp: 1791830000 } },
    };
    source.queue = [raw("sentry", back, "2026-10-12T18:00:00.000Z")];
    const r = await monitor.tick();
    expect(r.triaged[0]?.decision).toEqual({ action: "updated", ticketId });
    expect(r.triaged[0]?.triage.regression).toMatchObject({
      regression: true,
      release: "web@1.4.1",
    });
    expect((await tickets.get(ticketId))?.status).toBe("open");
    expect(tickets.comments.map((c) => c.body).join("\n")).toContain("Recurred after the fix");
    expect(await tickets.list()).toHaveLength(1);
  });

  test("ticket body is stable for the same input", async () => {
    const { source, monitor } = setup([fixable]);
    source.queue = [raw("sentry", sentryEvent, "2026-10-12T10:13:21.000Z")];
    const r = await monitor.tick();
    const t = r.triaged[0];
    if (!t) throw new Error("not triaged");
    expect(ticketBody(t.issue, t.triage)).toBe(ticketBody(t.issue, t.triage));
    expect(ticketBody(t.issue, t.triage)).not.toMatch(/\n\n\n/);
  });
});
