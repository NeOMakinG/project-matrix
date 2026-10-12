import { describe, expect, it } from "vitest";
import { defaultDraft, isAnswered, type RoundQuestion, submittedValue } from "./engine";

const question: RoundQuestion = {
  id: "server.question",
  pack: "Server pack",
  kind: "select",
  prompt: "Server prompt",
  rationale: "Server rationale",
  recommended: "new-option",
  dependsOn: [],
  options: [
    { id: "new-option", label: "New option", description: "Server description", recommended: true },
  ],
};

describe("server question presentation", () => {
  it("accepts server-defined recommendations without knowing a client pack", () => {
    expect(defaultDraft([question])).toEqual({ "server.question": "new-option" });
    expect(defaultDraft([{ ...question, recommended: false }])).toEqual({
      "server.question": false,
    });
    expect(defaultDraft([{ ...question, recommended: null }])).toEqual({});
  });
  it("parses lists only at submission", () => {
    const raw = "first\n\nsecond\n";
    expect(submittedValue({ ...question, kind: "list" }, raw)).toEqual(["first", "second"]);
    expect(submittedValue({ ...question, kind: "text" }, raw)).toBe(raw);
  });
  it("allows false and zero, but rejects non-finite numbers and empty lists", () => {
    expect(isAnswered({ ...question, kind: "confirm" }, false)).toBe(true);
    expect(isAnswered({ ...question, kind: "number" }, 0)).toBe(true);
    expect(isAnswered({ ...question, kind: "number" }, Number.NaN)).toBe(false);
    expect(isAnswered({ ...question, kind: "list" }, [])).toBe(false);
    expect(isAnswered({ ...question, kind: "multiselect" }, [])).toBe(true);
  });
});
