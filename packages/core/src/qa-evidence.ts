import type { Receipt } from "./ports.js";

export interface ScenarioEvidence {
  provenance: "host-probe";
  headSha: string;
  id: string;
  command: string[];
  exitCode: number;
  output: string;
  probe: string;
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
    !("id" in data) ||
    typeof data.id !== "string" ||
    !("command" in data) ||
    !Array.isArray(data.command) ||
    !data.command.length ||
    data.command.length > 8 ||
    !data.command.every(
      (argument): argument is string => typeof argument === "string" && argument.length <= 512,
    ) ||
    !("exitCode" in data) ||
    typeof data.exitCode !== "number" ||
    !Number.isInteger(data.exitCode) ||
    !("output" in data) ||
    typeof data.output !== "string" ||
    data.output.length > 4096 ||
    !("probe" in data) ||
    typeof data.probe !== "string" ||
    data.probe.length > 8192
  )
    return undefined;
  return {
    provenance: "host-probe",
    headSha: data.headSha,
    id: data.id,
    command: data.command,
    exitCode: data.exitCode,
    output: data.output,
    probe: data.probe,
  };
}

export function formatQaEvidence(receipts: Receipt[]): string {
  return JSON.stringify(
    receipts.map((receipt) => ({
      kind: receipt.kind,
      ok: receipt.ok,
      summary: receipt.summary,
      ...(scenarioEvidence(receipt) ? { scenario: scenarioEvidence(receipt) } : {}),
    })),
    null,
    2,
  );
}
