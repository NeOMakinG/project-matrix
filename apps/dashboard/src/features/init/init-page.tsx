import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { z } from "zod";
import type { InitProgress } from "@/api/contracts";
import { endpoints } from "@/api/endpoints";
import { queries } from "@/api/queries";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { QueryView } from "@/components/ui/states";
import { cn } from "@/lib/cn";

export function InitPage() {
  const { projectId } = useParams({ from: "/p/$projectId/init" });
  const { session } = useSearch({ from: "/p/$projectId/init" });
  return session ? <InitSession sessionId={session} /> : <StartInterview projectId={projectId} />;
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
          The interview walks every pack, recommends an answer for each question and writes{" "}
          <span className="font-mono text-fg">matrix.config.ts</span>, the ADRs and the first
          backlog.
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

function InitSession({ sessionId }: { sessionId: string }) {
  const query = useQuery(queries.init(sessionId));
  return (
    <QueryView query={query}>
      {({ session, progress }) => (
        <InitView
          sessionId={sessionId}
          completed={session.state === "completed"}
          progress={progress}
        />
      )}
    </QueryView>
  );
}

function InitView({
  sessionId,
  completed,
  progress,
}: {
  sessionId: string;
  completed: boolean;
  progress: InitProgress;
}) {
  const activeIndex = progress.packs.findIndex((p) => p.state === "active");
  const active = progress.packs[activeIndex];
  return (
    <>
      <PageHeader
        title="New project · Init interview"
        subtitle={
          completed
            ? `Interview complete · ${progress.answered.length} answers`
            : `Pack ${activeIndex + 1} of ${progress.packs.length} · ${active?.label ?? ""} · ${progress.answered.length} answers so far`
        }
        actions={
          <Button variant="primary" disabled={!completed}>
            Generate project
          </Button>
        }
      />
      <div className="grid grid-cols-[230px_minmax(0,1fr)_360px] gap-4">
        <Card className="self-start">
          <CardHeader title="Interview packs" />
          <ol className="space-y-0.5 px-2 pb-3">
            {progress.packs.map((pack) => (
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

        <div className="space-y-4">
          <Card className="px-5 py-4">
            <div className="text-caption text-fg-secondary">Answered so far</div>
            <dl className="mt-2 space-y-2">
              {progress.answered.slice(-8).map((a) => (
                <div key={a.questionId} className="flex justify-between gap-4">
                  <dt className="text-body text-fg-secondary">{a.label}</dt>
                  <dd className="font-mono text-caption text-fg">{a.value}</dd>
                </div>
              ))}
            </dl>
          </Card>
          {progress.question ? (
            <QuestionCard sessionId={sessionId} question={progress.question} />
          ) : (
            <Card className="px-5 py-6">
              <Pill tone="green">all questions answered</Pill>
              <p className="mt-3 text-body text-fg-secondary">
                Review the generated config and ADRs, then generate the project.
              </p>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="matrix.config.ts" meta={<Pill tone="neutral">draft</Pill>} />
            <pre className="mx-4 mb-4 overflow-x-auto rounded-control bg-canvas p-3 font-mono text-caption text-fg">
              {progress.configPreview}
            </pre>
          </Card>
          <Card>
            <CardHeader title="Generated ADRs" meta={String(progress.adrs.length)} />
            <ul className="space-y-3 px-4 pb-4">
              {progress.adrs.map((adr) => (
                <li
                  key={adr.id}
                  className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-2"
                >
                  <span className="font-mono text-caption text-fg-muted">{adr.id}</span>
                  <span className="text-body text-fg">{adr.title}</span>
                  <Pill tone={adr.status.tone}>{adr.status.label}</Pill>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

type Question = NonNullable<InitProgress["question"]>;

const answerFormSchema = z.object({ optionId: z.string().min(1, "Pick an option") });

function QuestionCard({ sessionId, question }: { sessionId: string; question: Question }) {
  const client = useQueryClient();
  const answer = useMutation({
    mutationFn: (optionId: string) => endpoints.answerInit(sessionId, question.id, optionId),
    onSuccess: () => client.invalidateQueries({ queryKey: queries.init(sessionId).queryKey }),
  });
  const recommended = question.options.find((o) => o.recommended)?.id ?? "";
  const form = useForm({
    defaultValues: { optionId: recommended },
    validators: { onSubmit: answerFormSchema },
    onSubmit: ({ value }) => answer.mutateAsync(value.optionId),
  });

  return (
    <Card className="px-5 py-5">
      <form
        key={question.id}
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="flex items-center gap-2">
          <Pill tone="blue">
            {question.pack} · {question.index} of {question.total}
          </Pill>
          <span className="font-mono text-caption text-fg-muted">{question.context}</span>
        </div>
        <h2 id="question-prompt" className="mt-3 text-title font-semibold">
          {question.prompt}
        </h2>
        <p className="mt-2 text-body text-fg-secondary">{question.rationale}</p>

        <form.Field name="optionId">
          {(field) => (
            <div role="radiogroup" aria-labelledby="question-prompt" className="mt-4 space-y-2">
              {question.options.map((option) => {
                const selected = field.state.value === option.id;
                return (
                  <label
                    key={option.id}
                    className={cn(
                      "block cursor-pointer rounded-card border px-4 py-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-2",
                      selected
                        ? "border-accent bg-accent-dim/40"
                        : "border-border-subtle bg-raised hover:border-border-strong",
                    )}
                  >
                    <input
                      type="radio"
                      name={field.name}
                      value={option.id}
                      checked={selected}
                      onChange={() => field.handleChange(option.id)}
                      className="sr-only"
                    />
                    <span className="flex items-center gap-3 text-heading text-fg">
                      {option.label}
                      {option.recommended ? (
                        <Pill tone="green" className="bg-transparent px-0">
                          Recommended
                        </Pill>
                      ) : null}
                    </span>
                    <span className="mt-1 block text-caption text-fg-secondary">
                      {option.description}
                    </span>
                  </label>
                );
              })}
              {field.state.meta.errors.length ? (
                <p role="alert" className="text-caption text-danger">
                  Pick an option
                </p>
              ) : null}
            </div>
          )}
        </form.Field>

        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="text-caption text-fg-secondary">{question.facts}</span>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(submitting) => (
              <Button type="submit" variant="primary" disabled={submitting}>
                Confirm & next
              </Button>
            )}
          </form.Subscribe>
        </div>
        {answer.isError ? (
          <p role="alert" className="mt-2 text-caption text-danger">
            Couldn't save the answer: {answer.error.message}
          </p>
        ) : null}
      </form>
    </Card>
  );
}
