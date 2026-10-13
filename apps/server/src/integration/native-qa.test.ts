import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type Receipt, type RunRecord } from "@matrix/core";
import { createHarness } from "@matrix/core/testing";
import { expect, test, vi } from "vitest";
import { nativeQaEvidence, nativeQaRedactor, writeNativeQaReceipt } from "./native-qa.js";

test("actual reconciler failure summary and Store events survive into a redacted private receipt", async () => {
  const key = "planted-gateway-credential-ONLY-TEST";
  const token = "mxr_plantedRunTokenOnlyTest123456";
  const harness = createHarness({ project: { maxAttempts: 1 } });
  await harness.setup();
  const ticket = harness.tickets.add("diagnostic fixture");
  const runner = vi
    .spyOn(harness.implementer, "run")
    .mockImplementation(async (request, onEvent) => {
      onEvent({
        runId: request.runId,
        at: new Date().toISOString(),
        kind: "log",
        message: `preflight reached ${token}`,
        data: { env: { KEY: key } },
      });
      onEvent({
        runId: request.runId,
        at: new Date().toISOString(),
        kind: "error",
        message: `fixture SPIKE failure: diagnostic-marker ${key}`,
      });
      throw new Error(
        `fixture SPIKE failure: diagnostic-marker ${key} ${Buffer.from(token).toString("base64")}`,
      );
    });
  const directory = await mkdtemp(join(tmpdir(), "matrix-native-qa-diagnostic-"));
  try {
    await harness.reconciler.tick();
    await harness.reconciler.idle();
    const runs = await harness.store.listRuns({ ticketId: ticket.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.summary).toContain("diagnostic-marker");
    const redact = nativeQaRedactor([key, token]);
    const evidence = await nativeQaEvidence(harness.store, runs, redact);
    expect(evidence[0]?.summary).toContain("fixture SPIKE failure: diagnostic-marker");
    expect(evidence[0]?.events.messages.map((event) => event.kind)).toEqual(["error", "log"]);
    expect(evidence[0]?.step.summaryStatus).toBe("unavailable");
    const path = join(directory, "receipts.json");
    await writeNativeQaReceipt(path, { runs: evidence, extra: key }, redact);
    const persisted = await readFile(path, "utf8");
    expect(persisted).toContain("diagnostic-marker");
    for (const secret of [key, token, Buffer.from(token).toString("base64")])
      expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('"env"');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    runner.mockRestore();
    harness.reconciler.stop();
    await harness.reconciler.idle();
    await rm(directory, { recursive: true, force: true });
  }
});

function run(): RunRecord {
  const now = new Date();
  return {
    id: "run",
    projectId: "fixture",
    ticketId: "ticket",
    phase: "spike",
    attempt: 0,
    stepKey: "step",
    host: "fixture",
    ownerId: "fixture",
    status: "failed",
    summary: "fixture blocked at SPIKE",
    startedAt: now,
    lastEventAt: now,
    heartbeatAt: now,
  };
}

test("step failures use only diagnostic fields; absent or unreadable events/steps stay unavailable", async () => {
  const store = new MemoryStore();
  const record = run();
  await store.startStep({
    key: record.stepKey,
    runId: record.id,
    phase: "spike",
    input: { env: "NEVER-PRINT" },
  });
  await store.completeStep(record.stepKey, {
    ok: false,
    output: {
      summary: "fixture phase handler rejected",
      runStatus: "failed",
      argv: ["NEVER-PRINT"],
      headers: { authorization: "NEVER-PRINT" },
    },
  });
  const redact = nativeQaRedactor([]);
  const evidence = await nativeQaEvidence(store, [record], redact);
  expect(evidence[0]?.step).toMatchObject({
    status: "available",
    ok: false,
    runStatus: "failed",
    summary: "fixture phase handler rejected",
  });
  expect(JSON.stringify(evidence)).not.toContain("NEVER-PRINT");
  expect(evidence[0]?.events).toMatchObject({ status: "available", messages: [], omittedCount: 0 });
  const broken = {
    listReceipts: store.listReceipts.bind(store),
    listEvents: async () => {
      throw new Error("NEVER-PRINT");
    },
    getStep: async () => {
      throw new Error("NEVER-PRINT");
    },
  };
  const withoutSummary = { ...record };
  delete withoutSummary.summary;
  const unavailable = await nativeQaEvidence(broken, [withoutSummary], redact);
  expect(unavailable[0]?.summaryStatus).toBe("unavailable");
  expect(unavailable[0]?.events.status).toBe("unavailable");
  expect(unavailable[0]?.step.status).toBe("unavailable");
  expect(JSON.stringify(unavailable)).not.toContain("NEVER-PRINT");
});

test("diagnostics bound counts/bytes and redact patterns, execution context and secret encodings", async () => {
  const started = performance.now();
  const key = "fixture-secret-value-for-redaction";
  const redact = nativeQaRedactor([key]);
  for (const encoded of [
    key,
    Buffer.from(key).toString("base64url"),
    Buffer.from(key).toString("hex"),
  ])
    expect(redact(encoded)).toBe("[REDACTED]");
  const text =
    "useful failure status=500\nargv: NEVER-PRINT\nenv: NEVER-PRINT\nheaders: NEVER-PRINT\nAuthorization: Bearer NEVER-PRINT\nAPI_KEY=NEVER-PRINT\nunknown sk-plantedFakeKey mxr_unknownFakeToken";
  expect(redact(text)).toContain("status=500");
  expect(redact(text)).not.toContain("NEVER-PRINT");
  expect(redact(text)).not.toContain("sk-plantedFakeKey");
  expect(redact(text)).not.toContain("mxr_unknownFakeToken");
  expect(redact("unknown sk-plantedFakeKey mxr_unknownFakeToken")).toBe(
    "unknown [REDACTED] [REDACTED]",
  );
  expect(redact('headers: {\n  "custom-header": "NEVER-PRINT"\n}')).not.toContain("NEVER-PRINT");
  const store = new MemoryStore();
  for (let index = 0; index < 100; index++)
    await store.appendEvent({
      runId: "run",
      at: new Date().toISOString(),
      kind: index === 0 ? "error" : "log",
      message: `${key}${"x".repeat(10_000)}`,
    });
  const evidence = await nativeQaEvidence(
    store,
    Array.from({ length: 100 }, () => ({ ...run(), summary: "x".repeat(10_000) })),
    redact,
  );
  expect(evidence).toHaveLength(64);
  expect(evidence[0]?.events.messages).toHaveLength(13);
  expect(evidence[0]?.events.messages[0]?.kind).toBe("error");
  expect(evidence[0]?.events.omittedCount).toBe(87);
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(160 * 1024);
  expect(JSON.stringify(evidence)).not.toContain(key);
  expect(performance.now() - started).toBeLessThan(1000);
});

test("private QA diagnostics retain only host-attested hashes, counts and same-SHA binding", async () => {
  const key = "planted-QA-receipt-secret-TEST";
  const receipt: Receipt = {
    kind: "test",
    ok: true,
    summary: "host-executed s2 probe exit 0",
    data: {
      provenance: "host-probe",
      headSha: "a".repeat(40),
      scenarioIndex: 1,
      probeSha256: "b".repeat(64),
      outputSha256: "c".repeat(64),
      durationMs: 12,
      probeBytes: 64,
      outputBytes: 32,
      passed: true,
      exitCode: 0,
      output: `actual=5 ${key}`,
      probe: 'import { add } from "./src/add.ts"; console.log(add(2,3));',
    },
  };
  const evidence = await nativeQaEvidence(
    {
      listEvents: async () => [],
      getStep: async () => null,
      listReceipts: async () => [receipt],
    },
    [run()],
    nativeQaRedactor([key]),
  );
  expect(evidence[0]?.receipts[0]?.scenario).toMatchObject({
    provenance: "host-probe",
    headSha: "a".repeat(40),
    scenarioIndex: 1,
    probeSha256: "b".repeat(64),
    outputSha256: "c".repeat(64),
    exitCode: 0,
  });
  expect(JSON.stringify(evidence)).not.toContain(key);
  expect(JSON.stringify(evidence)).not.toContain("actual=5");
  expect(JSON.stringify(evidence)).not.toContain("console.log");
});
