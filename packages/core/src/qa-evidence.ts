import type { Receipt } from "./ports.js";

export interface ScenarioEvidence {
  provenance: "host-probe";
  headSha: string;
  scenarioIndex: number;
  probeSha256: string;
  outputSha256: string;
  exitCode: number;
  durationMs: number;
  probeBytes: number;
  outputBytes: number;
  passed: boolean;
  plannerModel?: string;
}

export interface JudgeScenarioEvidence {
  headSha: string;
  id: string;
  command: string[];
  exitCode: number;
  output: string;
  probe: string;
}

export function publicQaReceipt(receipt: Receipt): Receipt {
  if (receipt.kind === "holdout") {
    const data = receipt.data as
      | {
          satisfied?: unknown;
          total?: unknown;
          satisfaction?: unknown;
        }
      | undefined;
    return {
      kind: receipt.kind,
      ok: receipt.ok,
      summary: "QA holdout evaluation complete",
      ...(data
        ? {
            data: {
              ...(typeof data.satisfied === "number" ? { satisfied: data.satisfied } : {}),
              ...(typeof data.total === "number" ? { total: data.total } : {}),
              ...(typeof data.satisfaction === "number" ? { satisfaction: data.satisfaction } : {}),
            },
          }
        : {}),
    };
  }
  if (
    receipt.data &&
    typeof receipt.data === "object" &&
    "provenance" in receipt.data &&
    receipt.data.provenance === "host-probe"
  )
    return { kind: receipt.kind, ok: receipt.ok, summary: "QA scenario probe completed" };
  if (receipt.data && typeof receipt.data === "object" && "output" in receipt.data)
    return { kind: receipt.kind, ok: receipt.ok, summary: "QA check completed" };
  return receipt;
}

export function scenarioEvidence(receipt: Receipt): ScenarioEvidence | undefined {
  const data = receipt.data;
  if (
    !data ||
    typeof data !== "object" ||
    !("provenance" in data) ||
    data.provenance !== "host-probe" ||
    !("headSha" in data) ||
    typeof data.headSha !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(data.headSha) ||
    !("scenarioIndex" in data) ||
    typeof data.scenarioIndex !== "number" ||
    !Number.isInteger(data.scenarioIndex) ||
    data.scenarioIndex < 0 ||
    !("probeSha256" in data) ||
    typeof data.probeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.probeSha256) ||
    !("outputSha256" in data) ||
    typeof data.outputSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.outputSha256) ||
    !("exitCode" in data) ||
    typeof data.exitCode !== "number" ||
    !Number.isInteger(data.exitCode) ||
    !("durationMs" in data) ||
    typeof data.durationMs !== "number" ||
    !Number.isFinite(data.durationMs) ||
    data.durationMs < 0 ||
    !("probeBytes" in data) ||
    typeof data.probeBytes !== "number" ||
    !Number.isInteger(data.probeBytes) ||
    data.probeBytes < 0 ||
    !("outputBytes" in data) ||
    typeof data.outputBytes !== "number" ||
    !Number.isInteger(data.outputBytes) ||
    data.outputBytes < 0 ||
    !("passed" in data) ||
    typeof data.passed !== "boolean"
  )
    return undefined;
  return {
    provenance: "host-probe",
    headSha: data.headSha,
    scenarioIndex: data.scenarioIndex,
    probeSha256: data.probeSha256,
    outputSha256: data.outputSha256,
    exitCode: data.exitCode,
    durationMs: data.durationMs,
    probeBytes: data.probeBytes,
    outputBytes: data.outputBytes,
    passed: data.passed,
    ...("plannerModel" in data && typeof data.plannerModel === "string"
      ? { plannerModel: data.plannerModel }
      : {}),
  };
}

export function persistedQaReceipt(receipt: Receipt): Receipt {
  const metadata = scenarioEvidence(receipt);
  if (metadata)
    return {
      kind: receipt.kind,
      ok: receipt.ok,
      summary: "Host-executed QA probe completed",
      data: metadata,
    };
  return publicQaReceipt(receipt);
}

export function formatQaEvidence(
  receipts: Receipt[],
  transient: JudgeScenarioEvidence[] = [],
): string {
  return JSON.stringify(
    {
      checks: receipts.map((receipt) => ({
        kind: receipt.kind,
        ok: receipt.ok,
        summary: receipt.summary,
        ...(scenarioEvidence(receipt) ? { scenario: scenarioEvidence(receipt) } : {}),
      })),
      scenarios: transient,
    },
    null,
    2,
  );
}
