import { createHash } from "node:crypto";
import type { ReplayCase } from "./evaluate.js";
import type { Candidate, CandidatePayload } from "./types.js";

/** JSON with object keys sorted recursively, so equal values always hash equally. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function patchHash(projectId: string, id: string, payload: CandidatePayload): string {
  return sha256(canonical({ projectId, id, payload }));
}

export const candidateHash = (c: Pick<Candidate, "projectId" | "id" | "payload">) =>
  patchHash(c.projectId, c.id, c.payload);

export function caseSetHash(cases: ReplayCase[]): string {
  const ordered = [...cases]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      ticketId: c.ticketId,
      phase: c.phase,
      input: c.input,
      expectedP1: [...c.expectedP1].sort(),
    }));
  return sha256(canonical(ordered));
}
