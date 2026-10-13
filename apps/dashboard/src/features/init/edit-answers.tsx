import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { reviseInitAnswer } from "@/api/init-cache";
import type { InitProgress } from "@/api/view";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import {
  type Answers,
  isAnswered,
  isAnswerValue,
  type RoundQuestion,
  roundQuestionSchema,
  submittedValue,
} from "./engine";
import { QuestionField } from "./round-form";

export function EditAnswersCard({
  sessionId,
  ids,
  answers,
  onDone,
  answered,
  knownQuestions,
  onDropped,
}: {
  sessionId: string;
  ids: string[];
  answers: Answers;
  onDone: () => void;
  answered: InitProgress["answered"];
  knownQuestions: Map<string, RoundQuestion>;
  onDropped: (ids: string[]) => void;
}) {
  const client = useQueryClient();
  const questionId = ids.find((id) => answers[id] !== undefined);
  const current = questionId ? answers[questionId] : undefined;
  const confirmed = roundQuestionSchema.safeParse(
    answered.find((answer) => answer.questionId === questionId),
  );
  const remembered =
    confirmed.success && confirmed.data.id === questionId
      ? confirmed.data
      : questionId
        ? knownQuestions.get(questionId)
        : undefined;
  const [draft, setDraft] = useState(current);
  const [raw, setRaw] = useState(() => JSON.stringify(current, null, 2) ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const value =
    remembered && draft !== undefined
      ? submittedValue(remembered, draft)
      : isAnswerValue(parsed)
        ? parsed
        : undefined;
  const changed = questionId && JSON.stringify(value) !== JSON.stringify(current);
  const save = useMutation({
    mutationFn: () => {
      if (!questionId || value === undefined) throw new Error("Choose a confirmed answer to edit");
      return reviseInitAnswer(client, sessionId, questionId, value);
    },
    onSuccess: (response) => {
      onDropped(response.dropped);
      onDone();
    },
  });
  const incomplete = remembered ? !isAnswered(remembered, draft) : value === undefined;

  return (
    <Card>
      <CardHeader title="Change answers" meta={questionId ? "1 question" : "0 questions"} />
      <div className="space-y-5 px-5 pb-5">
        {!questionId ? (
          <p className="text-body text-fg-secondary">
            These questions no longer apply to your answers.
          </p>
        ) : null}
        {remembered ? (
          <QuestionField
            question={remembered}
            value={draft}
            missing={incomplete}
            onChange={setDraft}
          />
        ) : questionId ? (
          <div className="space-y-2">
            <p className="text-caption text-fg-secondary">
              Question metadata is unavailable from this server. Edit the raw JSON value; the server
              validates its kind, options, and whether it may be empty.
            </p>
            <label className="block text-body">
              {answered.find((answer) => answer.questionId === questionId)?.label ?? questionId}
              <textarea
                className="mt-2 w-full rounded-control border border-border-strong bg-canvas px-3 py-2 font-mono text-body"
                rows={3}
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
              />
            </label>
            {incomplete ? (
              <p role="alert">Use a JSON string, finite number, boolean, or string array.</p>
            ) : null}
          </div>
        ) : null}
        <p className="text-caption text-fg-secondary">
          Changes are checked by the server. Dependent answers may be invalidated and asked again.
          Edit one confirmed answer at a time.
        </p>
        {save.isError ? (
          <p role="alert" className="text-caption text-danger">
            The server rejected the change: {save.error.message}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={save.isPending || incomplete || !changed}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
          <Button onClick={onDone} disabled={save.isPending}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function AnswersCard({
  answered,
  onEdit,
  editable = true,
}: {
  answered: InitProgress["answered"];
  onEdit: (questionId: string) => void;
  editable?: boolean;
}) {
  return (
    <Card className="self-start">
      <CardHeader title="Your answers" meta={String(answered.length)} />
      <ul className="max-h-96 space-y-1 overflow-y-auto px-2 pb-3">
        {answered.length === 0 ? (
          <li className="px-2 text-caption text-fg-muted">Nothing yet.</li>
        ) : null}
        {answered.map((a) => (
          <li
            key={a.questionId}
            className="flex items-start justify-between gap-2 rounded-control px-2 py-1.5 hover:bg-hover"
          >
            <span className="min-w-0">
              <span className="block truncate text-caption text-fg-secondary">{a.label}</span>
              <span className="block truncate font-mono text-caption text-fg">{a.value}</span>
            </span>
            <button
              type="button"
              disabled={!editable}
              onClick={() => onEdit(a.questionId)}
              aria-label={`Edit answer: ${a.label}`}
              className="shrink-0 rounded px-1.5 text-caption text-accent hover:underline"
            >
              Edit
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
