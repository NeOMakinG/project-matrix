import { sampleAnswers } from "@matrix/packs";
import { describe, expect, it } from "vitest";
import { buildRound, contradictions, defaultDraft, isAnswered, preview } from "./engine";

describe("init engine (same packs the server validates with)", () => {
  it("first round asks every answerable business question at once", () => {
    const round = buildRound({});
    expect(round.length).toBeGreaterThan(1);
    expect(
      round.every((q) => q.packTitle === round[0]?.packTitle || q.id.startsWith("business.")),
    ).toBe(true);
    expect(round.map((q) => q.id)).toContain("business.name");
  });

  it("honours when conditions: React questions only appear for a web UI", () => {
    const all = (answers: Record<string, unknown>) => buildRound(answers as never).map((q) => q.id);
    const noWeb = all({
      ...sampleAnswers,
      "platforms.targets": ["api"],
      "frontend.framework": undefined,
    });
    expect(noWeb.some((id) => id.startsWith("frontend."))).toBe(false);
  });

  it("preselects the recommended answer and keeps alternatives", () => {
    const answers = { ...sampleAnswers };
    delete answers["process.tickets"];
    const round = buildRound(answers);
    const tickets = round.find((q) => q.id === "process.tickets");
    expect(tickets?.options.find((o) => o.recommended)?.value).toBe("beads");
    expect((tickets?.options.length ?? 0) > 1).toBe(true);
    expect(defaultDraft(round)["process.tickets"]).toBe("beads");
  });

  it("flags contradictions", () => {
    const found = contradictions({
      ...sampleAnswers,
      "backend.kind": "none",
      "backend.auth": "better-auth",
    });
    expect(found.map((c) => c.id)).toContain("self-hosted-auth-without-backend");
    expect(contradictions(sampleAnswers).filter((c) => c.severity === "error")).toEqual([]);
  });

  it("previews matrix.config.ts and ADR titles", () => {
    const { config, adrs } = preview(sampleAnswers);
    expect(config).toContain("defineConfig(");
    expect(adrs.length).toBeGreaterThan(0);
  });

  it("knows when a question still needs an answer", () => {
    const [q] = buildRound({});
    if (!q) throw new Error("round");
    expect(isAnswered(q, undefined)).toBe(false);
    expect(isAnswered({ ...q, kind: "text" }, "  ")).toBe(false);
    expect(isAnswered({ ...q, kind: "confirm" }, false)).toBe(true);
    expect(isAnswered({ ...q, kind: "multiselect" }, [])).toBe(true);
  });
});
