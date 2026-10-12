import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { endpoints } from "@/api/endpoints";
import { queries } from "@/api/queries";
import type { InitProgress } from "@/api/view";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { QueryView } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { AutonomyStep } from "./autonomy-step";
import {
  type Answers,
  type AnswerValue,
  buildRound,
  contradictions,
  defaultDraft,
  isAnswered,
  preview,
  type RoundQuestion,
} from "./engine";
import { QuestionField } from "./round-form";
import { ContradictionsCard, FinalizeStep, PreviewCards } from "./side-panels";

export function InitPage() {
  const { projectId } = useParams({ from: "/p/$projectId/init" });
  const { session } = useSearch({ from: "/p/$projectId/init" });
  return session ? (
    <InitSession projectId={projectId} sessionId={session} />
  ) : (
    <StartInterview projectId={projectId} />
  );
}

function StartInterview({ projectId }: { projectId: string }) {
  const navigate = useNavigate({ from: "/p/$projectId/init" });
  const start = useMutation({
    mutationFn: () => endpoints.startInit(projectId),
    onSuccess: (session) => navigate({ search: { session: session.id } }),
  });
  return (
    <>
      <PageHeader
        title="Init interview"
        subtitle={`${projectId} · business, product, stack, hosting, design, process`}
      />
      <Card className="max-w-xl px-5 py-5">
        <p className="text-body text-fg-secondary">
          Each round asks every question that can be answered now, with the recommended answer
          preselected.
        </p>
        <Button
          className="mt-4"
          variant="primary"
          onClick={() => start.mutate()}
          disabled={start.isPending}
        >
          Start interview
        </Button>
        {start.isError ? (
          <p role="alert" className="mt-2 text-caption text-danger">
            Couldn't start the interview: {start.error.message}
          </p>
        ) : null}
      </Card>
    </>
  );
}

const isAnswerValue = (v: unknown): v is AnswerValue =>
  ["string", "number", "boolean"].includes(typeof v) ||
  (Array.isArray(v) && v.every((x) => typeof x === "string"));

function toAnswers(raw: Record<string, unknown>): Answers {
  const out: Answers = {};
  for (const [k, v] of Object.entries(raw)) if (isAnswerValue(v)) out[k] = v;
  return out;
}

function InitSession({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const query = useQuery(queries.init(sessionId));
  const project = useQuery(queries.project(projectId));
  const projectName = project.data?.name ?? projectId;
  return (
    <QueryView query={query}>
      {({ session, progress }) => (
        <Interview
          key={JSON.stringify(session.answers)}
          projectId={projectId}
          projectName={projectName}
          sessionId={sessionId}
          answers={toAnswers(session.answers)}
          progress={progress}
        />
      )}
    </QueryView>
  );
}

function Interview({
  projectId,
  projectName,
  sessionId,
  answers,
  progress,
}: {
  projectId: string;
  projectName: string;
  sessionId: string;
  answers: Answers;
  progress: InitProgress;
}) {
  const round = useMemo(() => buildRound(answers), [answers]);
  const [draft, setDraft] = useState<Answers>(() => defaultDraft(round));
  const [autonomySaved, setAutonomySaved] = useState(false);
  const merged = useMemo(() => ({ ...answers, ...draft }), [answers, draft]);
  const issues = useMemo(() => contradictions(merged), [merged]);
  const live = useMemo(() => preview(merged), [merged]);
  const done = round.length === 0;

  return (
    <>
      <PageHeader
        title={`${projectName} · Init interview`}
        subtitle={
          done
            ? `Interview complete · ${Object.keys(answers).length} answers`
            : `${round.length} question${round.length > 1 ? "s" : ""} this round · ${Object.keys(answers).length} answered so far`
        }
      />
      <div className="grid grid-cols-[220px_minmax(0,1fr)_380px] gap-4">
        <PacksCard packs={progress.packs} />
        <div className="space-y-4">
          {!done ? (
            <RoundCard
              sessionId={sessionId}
              round={round}
              draft={draft}
              blocking={issues.filter((c) => c.severity === "error").length}
              onChange={(id, value) => setDraft((d) => ({ ...d, [id]: value }))}
            />
          ) : autonomySaved ? (
            <FinalizeStep
              projectId={projectId}
              sessionId={sessionId}
              blocking={issues.filter((c) => c.severity === "error").length}
            />
          ) : (
            <AutonomyStep
              projectId={projectId}
              answers={answers}
              onSaved={() => setAutonomySaved(true)}
            />
          )}
        </div>
        <div className="space-y-4">
          <ContradictionsCard items={issues} />
          <PreviewCards config={live.config} adrs={live.adrs} />
        </div>
      </div>
    </>
  );
}

function PacksCard({ packs }: { packs: InitProgress["packs"] }) {
  return (
    <Card className="self-start">
      <CardHeader title="Interview packs" />
      <ol className="space-y-0.5 px-2 pb-3">
        {packs.map((pack) => (
          <li
            key={pack.id}
            aria-current={pack.state === "active" ? "step" : undefined}
            className={cn(
              "flex items-center justify-between rounded-control px-2 py-1.5 text-body",
              pack.state === "active"
                ? "bg-hover text-fg"
                : pack.state === "done"
                  ? "text-fg"
                  : "text-fg-secondary",
            )}
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  pack.state === "done" && "bg-accent",
                  pack.state === "active" && "bg-info",
                  pack.state === "todo" && "bg-fg-muted",
                )}
              />
              {pack.label}
            </span>
            <span className="font-mono text-caption text-fg-muted">
              {pack.answered}/{pack.total}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function RoundCard({
  sessionId,
  round,
  draft,
  blocking,
  onChange,
}: {
  sessionId: string;
  round: RoundQuestion[];
  draft: Answers;
  blocking: number;
  onChange: (id: string, value: AnswerValue) => void;
}) {
  const client = useQueryClient();
  const [showMissing, setShowMissing] = useState(false);
  const missing = round.filter((q) => !isAnswered(q, draft[q.id]));
  const submit = useMutation({
    mutationFn: () => {
      const answers = Object.fromEntries(round.map((q) => [q.id, draft[q.id] as AnswerValue]));
      return endpoints.answerInit(sessionId, answers);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queries.init(sessionId).queryKey }),
  });

  return (
    <Card>
      <CardHeader
        title="This round"
        meta={`${round.length} questions · recommended answers preselected`}
      />
      <form
        className="space-y-5 px-5 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (missing.length) return setShowMissing(true);
          submit.mutate();
        }}
      >
        {round.map((q) => (
          <QuestionField
            key={q.id}
            question={q}
            value={draft[q.id]}
            missing={showMissing && !isAnswered(q, draft[q.id])}
            onChange={(value) => onChange(q.id, value)}
          />
        ))}
        {blocking > 0 ? (
          <p className="text-caption text-warn">
            {blocking} contradiction{blocking > 1 ? "s" : ""} in these answers. You can still
            continue and fix them by changing the questions listed.
          </p>
        ) : null}
        {submit.isError ? (
          <p role="alert" className="text-caption text-danger">
            The server rejected the answers: {submit.error.message}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={submit.isPending}>
          {submit.isPending
            ? "Saving…"
            : `Confirm ${round.length} answer${round.length > 1 ? "s" : ""}`}
        </Button>
      </form>
    </Card>
  );
}
