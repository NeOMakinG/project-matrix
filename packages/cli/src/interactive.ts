import * as p from "@clack/prompts";
import {
  type Answers,
  type AnswerValue,
  defaultPacks,
  findContradictions,
  nextRound,
  type Pack,
  type Question,
  recommendedFor,
} from "@matrix/packs";

function cancelled(v: unknown): never | void {
  if (p.isCancel(v)) {
    p.cancel("Interview cancelled. Nothing was written.");
    process.exit(1);
  }
}

async function ask(q: Question, answers: Answers): Promise<AnswerValue> {
  const rec = recommendedFor(q, answers);
  const hint = q.rationale ? ` (${q.rationale})` : "";
  switch (q.kind) {
    case "select": {
      const v = await p.select({
        message: `${q.prompt}${hint}`,
        options: (q.options ?? []).map((o) => ({
          value: o.value,
          label: o.value === rec ? `${o.label} (recommended)` : o.label,
          ...(o.rationale ? { hint: o.rationale } : {}),
        })),
        ...(typeof rec === "string" ? { initialValue: rec } : {}),
      });
      cancelled(v);
      return v as string;
    }
    case "multiselect": {
      const v = await p.multiselect({
        message: `${q.prompt}${hint}`,
        options: (q.options ?? []).map((o) => ({
          value: o.value,
          label: o.label,
          ...(o.rationale ? { hint: o.rationale } : {}),
        })),
        initialValues: Array.isArray(rec) ? rec : [],
        required: false,
      });
      cancelled(v);
      return v as string[];
    }
    case "confirm": {
      const v = await p.confirm({ message: `${q.prompt}${hint}`, initialValue: rec === true });
      cancelled(v);
      return v as boolean;
    }
    case "number": {
      const v = await p.text({
        message: `${q.prompt}${hint}`,
        initialValue: rec === undefined ? "" : String(rec),
        validate: (s) => (s && Number.isFinite(Number(s)) ? undefined : "Enter a number"),
      });
      cancelled(v);
      return Number(v);
    }
    default: {
      const initial = Array.isArray(rec) ? rec.join(", ") : rec === undefined ? "" : String(rec);
      const v = await p.text({
        message: `${q.prompt}${hint}`,
        initialValue: initial,
        validate: (s) => (q.kind === "text" && !s ? "Required" : undefined),
      });
      cancelled(v);
      return v as string;
    }
  }
}

/** Grilling-style interview: every answerable question per round, recommended answers preselected. */
export async function interview(initial: Answers, packs: Pack[] = defaultPacks): Promise<Answers> {
  const answers: Answers = { ...initial };
  p.intro("Project Matrix: init interview");
  for (let guard = 0; guard < 20; guard++) {
    for (
      let round = nextRound(packs, answers);
      round.length > 0;
      round = nextRound(packs, answers)
    ) {
      p.log.step(
        `Round: ${[...new Set(round.map((q) => q.pack))].join(", ")} (${round.length} questions)`,
      );
      for (const q of round) answers[q.id] = await ask(q, answers);
    }
    const errors = findContradictions(answers).filter((c) => c.severity === "error");
    if (errors.length === 0) break;
    for (const c of errors) {
      p.log.warn(c.message);
      for (const id of c.questions) delete answers[id];
    }
  }
  p.outro("Interview complete.");
  return answers;
}
