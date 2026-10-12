/**
 * Live receipt: runs the whole prod loop on a recorded Sentry fixture with a real LLM
 * through the CLIProxyAPI gateway. Prints the triage and the generated ticket, never the key.
 *
 *   MATRIX_GATEWAY_URL=… MATRIX_GATEWAY_KEY=… bun src/live-triage.ts [model]
 * Falls back to `base_url` / `api_key` in ~/.hermes/config.yaml when the env vars are unset.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import sentryEvent from "./fixtures/sentry-event.json";
import { MemoryIssueStore } from "./group.js";
import { GatewayLlm } from "./llm.js";
import { Monitor } from "./monitor.js";
import { FakeTicketStore, fakeGraph, QueueSource, raw, staticReleases } from "./testing.js";

function gateway(): { url: string; key: string } {
  const url = process.env.MATRIX_GATEWAY_URL;
  const key = process.env.MATRIX_GATEWAY_KEY;
  if (url && key) return { url, key };
  const cfg = readFileSync(join(homedir(), ".hermes", "config.yaml"), "utf8");
  const u = cfg.match(/base_url:\s*(\S+)/)?.[1];
  const k = cfg.match(/api_key:\s*(\S+)/)?.[1]?.replace(/^["']|["']$/g, "");
  if (!u || !k) throw new Error("no gateway configured");
  return { url: u, key: k };
}

const model = process.argv[2] ?? "gpt-6.1-sol";
const gw = gateway();
const source = new QueueSource([raw("sentry", sentryEvent, "2026-10-12T10:13:21.000Z")]);
const tickets = new FakeTicketStore();
const started = Date.now();
const monitor = new Monitor({
  source,
  store: new MemoryIssueStore(),
  tickets,
  llm: new GatewayLlm({ baseUrl: gw.url, apiKey: gw.key }),
  graph: fakeGraph,
  releases: staticReleases([
    { release: "web@1.3.0", deployedAt: "2026-10-10T10:00:00.000Z" },
    { release: "web@1.4.0", deployedAt: "2026-10-12T08:00:00.000Z" },
  ]),
  model,
  defaultProjectId: "ledgerly",
  clock: () => "2026-10-12T10:30:00.000Z",
});

const result = await monitor.tick();
const t = result.triaged[0];
if (!t) throw new Error("nothing triaged");
const [ticket] = await tickets.list();
console.log(
  JSON.stringify(
    {
      model,
      latencyMs: Date.now() - started,
      fingerprint: t.issue.fingerprint,
      severity: t.triage.severity,
      regression: t.triage.regression,
      assessment: t.triage.assessment,
      promptVersion: t.triage.promptVersion,
      promptHash: t.triage.promptHash,
      decision: t.decision,
      ticket: ticket && {
        id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        labels: ticket.labels,
      },
    },
    null,
    2,
  ),
);
console.log("\n--- ticket body ---\n" + (ticket?.body ?? ""));
