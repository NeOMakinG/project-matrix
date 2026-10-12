import { useState } from "react";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";
import type { AnswerValue, RoundQuestion } from "./engine";

const choiceClass = (selected: boolean) =>
  cn(
    "block cursor-pointer rounded-card border px-3.5 py-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-2",
    selected
      ? "border-accent bg-accent-dim/40"
      : "border-border-subtle bg-raised hover:border-border-strong",
  );

const inputClass =
  "mt-2 w-full rounded-control border border-border-strong bg-canvas px-3 py-2 text-body outline-none focus:border-accent";

export function QuestionField({
  question,
  value,
  missing,
  onChange,
}: {
  question: RoundQuestion;
  value: AnswerValue | undefined;
  missing: boolean;
  onChange: (value: AnswerValue) => void;
}) {
  const promptId = `q-${question.id}`;
  return (
    <section
      aria-labelledby={promptId}
      className="border-border-subtle border-b pb-5 last:border-0 last:pb-0"
    >
      <div className="flex items-center gap-2">
        <Pill tone="blue">{question.pack}</Pill>
        <span className="font-mono text-caption text-fg-muted">{question.id}</span>
      </div>
      <h3 id={promptId} className="mt-2 text-heading font-semibold text-fg">
        {question.prompt}
      </h3>
      {question.rationale ? (
        <p className="mt-1 text-caption text-fg-secondary">{question.rationale}</p>
      ) : null}
      <div className="mt-3">
        <Input question={question} value={value} promptId={promptId} onChange={onChange} />
      </div>
      {missing ? (
        <p role="alert" className="mt-2 text-caption text-danger">
          This question needs an answer.
        </p>
      ) : null}
    </section>
  );
}

function Input({
  question,
  value,
  promptId,
  onChange,
}: {
  question: RoundQuestion;
  value: AnswerValue | undefined;
  promptId: string;
  onChange: (value: AnswerValue) => void;
}) {
  switch (question.kind) {
    case "select":
      return (
        <div role="radiogroup" aria-labelledby={promptId} className="grid gap-2">
          {question.options.map((o) => (
            <label key={o.id} className={choiceClass(value === o.id)}>
              <input
                type="radio"
                value={o.id}
                name={question.id}
                className="sr-only"
                checked={value === o.id}
                onChange={() => onChange(o.id)}
              />
              <span className="flex items-center gap-2 text-body text-fg">
                {o.label}
                {o.recommended ? (
                  <Pill tone="green" className="bg-transparent px-0">
                    Recommended
                  </Pill>
                ) : null}
              </span>
              {o.description ? (
                <span className="mt-0.5 block text-caption text-fg-secondary">{o.description}</span>
              ) : null}
            </label>
          ))}
        </div>
      );
    case "multiselect": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div role="group" aria-labelledby={promptId} className="flex flex-wrap gap-2">
          {question.options.map((o) => {
            const checked = selected.includes(o.id);
            return (
              <label
                key={o.id}
                className={cn(choiceClass(checked), "py-1.5")}
                title={o.description}
              >
                <input
                  type="checkbox"
                  value={o.id}
                  className="sr-only"
                  checked={checked}
                  onChange={() =>
                    onChange(checked ? selected.filter((v) => v !== o.id) : [...selected, o.id])
                  }
                />
                <span className="text-body text-fg">
                  {o.label}
                  {o.recommended ? (
                    <span className="ml-1.5 text-caption text-accent">recommended</span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      );
    }
    case "confirm":
      return (
        <div role="radiogroup" aria-labelledby={promptId} className="grid grid-cols-2 gap-2">
          {([true, false] as const).map((option) => (
            <label key={String(option)} className={choiceClass(value === option)}>
              <input
                type="radio"
                name={question.id}
                className="sr-only"
                checked={value === option}
                onChange={() => onChange(option)}
              />
              <span className="text-body text-fg">
                {option ? "Yes" : "No"}
                {question.recommended === option ? (
                  <span className="ml-1.5 text-caption text-accent">recommended</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      );
    case "number":
      return (
        <input
          type="number"
          aria-labelledby={promptId}
          className={inputClass}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        />
      );
    case "list":
      return <ListInput promptId={promptId} value={value} onChange={onChange} />;
    default:
      return (
        <input
          aria-labelledby={promptId}
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** Keeps the raw text (newlines included) while typing; the answer is the non-empty lines. */
export function ListInput({
  promptId,
  value,
  onChange,
}: {
  promptId: string;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue) => void;
}) {
  const [raw, setRaw] = useState(() =>
    Array.isArray(value) ? value.join("\n") : String(value ?? ""),
  );
  return (
    <textarea
      aria-labelledby={promptId}
      rows={3}
      className={inputClass}
      placeholder="One per line"
      value={raw}
      onChange={(e) => {
        setRaw(e.target.value);
        onChange(e.target.value);
      }}
    />
  );
}
