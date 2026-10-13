import { describe, expect, test } from "vitest";
import { makeProgress } from "./init";

describe("init progress dev fixture descriptors", () => {
  test("base confirmed answers contain every SDK descriptor without changing displayed values", () => {
    const progress = makeProgress({});
    expect(progress.answered.map((answer) => answer.value)).toEqual([
      "React 19 + Vite",
      "TanStack Router (typed routes)",
      "Tailwind v4 + shadcn/ui",
    ]);
    for (const answer of progress.answered) {
      expect(Object.keys(answer).sort()).toEqual([
        "dependsOn",
        "id",
        "kind",
        "label",
        "options",
        "pack",
        "prompt",
        "questionId",
        "rationale",
        "recommended",
        "value",
      ]);
      expect(answer.id).toBe(answer.questionId);
      expect(answer.prompt).toBe(answer.label);
      expect(answer.kind).toBe("select");
      expect(answer.dependsOn).toEqual([]);
      expect(answer.options.find((option) => option.id === answer.recommended)).toMatchObject({
        label: answer.value,
        description: "",
        recommended: true,
      });
    }
  });

  test("confirmed question preserves its complete round descriptor and recommendation", () => {
    const current = makeProgress({}).round[0]!;
    const selected = current.options.find((option) => !option.recommended)!;
    const progress = makeProgress({ [current.id]: selected.id });
    expect(progress.answered.at(-1)).toEqual({
      ...current,
      questionId: current.id,
      label: current.prompt,
      value: selected.label,
    });
    expect(progress.question?.id).toBe("stack.web.forms");
  });
});
