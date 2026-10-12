import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { api } from "@/api/client";
import { queries } from "@/api/queries";
import type { Run } from "@/api/schemas";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { QueryView } from "@/components/ui/states";
import { clock, usd } from "@/lib/format";
import { Findings, Holdout, LiveLog, PhaseStepper, Receipts } from "./run-parts";

export function RunPage() {
  const { runId } = useParams({ from: "/p/$projectId/runs/$runId" });
  const run = useQuery(queries.run(runId));
  return <QueryView query={run}>{(data) => <RunView run={data} />}</QueryView>;
}

function useRunMutation<TArgs>(runId: string, fn: (args: TArgs) => Promise<Run>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (run) => client.setQueryData(queries.run(runId).queryKey, run),
  });
}

function RunView({ run }: { run: Run }) {
  const pause = useRunMutation(run.id, () => api.pauseRun(run.id));
  const decide = useRunMutation(run.id, (decision: "approved" | "changes_requested") =>
    api.decideMerge(run.id, decision),
  );
  const qaPassed = run.receipts.length >= run.receiptsExpected && run.receipts.every((r) => r.ok);

  return (
    <>
      <PageHeader
        title={`${run.ticketId} · ${run.title}`}
        subtitle={`Run ${run.id} · started ${clock(run.startedAt).slice(0, 5)} · ${run.projectId}`}
        actions={
          <>
            <Button asChild>
              <a href={run.workspace.url} title={run.workspace.label}>
                Open in Orca
              </a>
            </Button>
            <Button onClick={() => pause.mutate(undefined)} disabled={pause.isPending}>
              {run.status === "paused" ? "Resume run" : "Pause run"}
            </Button>
            <Button asChild>
              <a href={run.pullRequest.url} target="_blank" rel="noreferrer">
                Open draft PR #{run.pullRequest.number}
                <ExternalLink className="size-3" />
              </a>
            </Button>
          </>
        }
      />

      <PhaseStepper phases={run.phases} />

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)_400px] gap-4">
        <div className="space-y-4">
          <LiveLog runId={run.id} initial={run.log} />
          <Findings findings={run.findings} />
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Runners" meta="per phase" />
            <dl className="space-y-3 px-4 pb-4">
              {run.runners.map((r) => (
                <Row key={r.phase} term={r.phase} value={`${r.runner} · ${r.model}`} />
              ))}
              <Row term="workspace" value={run.workspace.label} />
              <Row
                term="cost so far"
                value={`${usd(run.costUsd)} · ${Math.round(run.tokens / 1000)}k tokens`}
              />
            </dl>
          </Card>

          <Receipts receipts={run.receipts} expected={run.receiptsExpected} />
          <Holdout holdout={run.holdout} />

          <Card>
            <CardHeader title="Merge" meta={<Pill tone="amber">{run.merge.mode}</Pill>} />
            <div className="px-4 pb-4">
              <p className="text-body text-fg-secondary">{run.merge.note}</p>
              {run.merge.decision === "pending" ? (
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Button
                    size="lg"
                    onClick={() => decide.mutate("changes_requested")}
                    disabled={decide.isPending}
                  >
                    Request changes
                  </Button>
                  <Button
                    size="lg"
                    variant="primary"
                    onClick={() => decide.mutate("approved")}
                    disabled={decide.isPending}
                  >
                    {qaPassed ? "Approve & merge" : "Approve & merge after QA"}
                  </Button>
                </div>
              ) : (
                <Pill tone={run.merge.decision === "approved" ? "green" : "amber"} className="mt-4">
                  {run.merge.decision === "approved"
                    ? "approved · merges after QA"
                    : "changes requested"}
                </Pill>
              )}
              {decide.isError ? (
                <p role="alert" className="mt-2 text-caption text-danger">
                  Couldn't record the decision. Try again.
                </p>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-body text-fg-secondary">{term}</dt>
      <dd className="truncate font-mono text-caption text-fg">{value}</dd>
    </div>
  );
}
