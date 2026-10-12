import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { endpoints } from "@/api/endpoints";
import { queries } from "@/api/queries";
import { AUTONOMY_LABEL, type RunView } from "@/api/view";
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
  return <QueryView query={run}>{(data) => <RunDetail run={data} />}</QueryView>;
}

function RunDetail({ run }: { run: RunView }) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: queries.run(run.id).queryKey });
  const pause = useMutation({ mutationFn: () => endpoints.pauseRun(run.id), onSuccess: refresh });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approved" | "rejected" }) =>
      endpoints.decide(id, decision),
    onSuccess: refresh,
  });

  return (
    <>
      <PageHeader
        title={`${run.ticketId} · ${run.title}`}
        subtitle={`Run ${run.id} · started ${clock(run.startedAt).slice(0, 5)} UTC · ${run.projectId} · ${run.state}`}
        actions={
          <>
            {run.workspaceUrl ? (
              <Button asChild>
                <a href={run.workspaceUrl} rel="noopener noreferrer">
                  Open in Orca
                </a>
              </Button>
            ) : null}
            {run.pullRequestUrl ? (
              <Button asChild>
                <a href={run.pullRequestUrl} target="_blank" rel="noopener noreferrer">
                  Open draft PR
                </a>
              </Button>
            ) : null}
            <Button
              onClick={() => pause.mutate()}
              disabled={pause.isPending || run.status !== "running"}
            >
              Pause run
            </Button>
          </>
        }
      />

      <PhaseStepper phases={run.phases} />

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)_400px] gap-4">
        <div className="space-y-4">
          <LiveLog runId={run.id} />
          <Findings findings={run.findings} />
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Runner" meta={run.phase} />
            <dl className="space-y-3 px-4 pb-4">
              <Row term={run.phase} value={`${run.runner} · ${run.model}`} />
              <Row term="commit" value={run.headSha ? run.headSha.slice(0, 7) : "—"} />
              <Row term="cost so far" value={usd(run.costUsd)} />
            </dl>
          </Card>

          <Receipts receipts={run.receipts} />
          {run.holdout ? <Holdout holdout={run.holdout} /> : null}

          <Card>
            <CardHeader
              title="Merge"
              meta={<Pill tone="amber">{AUTONOMY_LABEL[run.mergeMode]}</Pill>}
            />
            <div className="px-4 pb-4">
              {decide.isSuccess ? (
                <Pill tone={decide.data.status === "approved" ? "green" : "amber"}>
                  {decide.data.status === "approved"
                    ? `approved at ${decide.data.headSha.slice(0, 7)}`
                    : "rejected"}
                </Pill>
              ) : run.approval ? (
                <>
                  <p className="text-body text-fg-secondary">
                    Approval requested for commit{" "}
                    <span className="font-mono text-fg">{run.approval.headSha.slice(0, 7)}</span>. A
                    newer push opens a new approval.
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <Button
                      size="lg"
                      disabled={decide.isPending}
                      onClick={() =>
                        decide.mutate({ id: run.approval?.id ?? "", decision: "rejected" })
                      }
                    >
                      Reject
                    </Button>
                    <Button
                      size="lg"
                      variant="primary"
                      disabled={decide.isPending}
                      onClick={() =>
                        decide.mutate({ id: run.approval?.id ?? "", decision: "approved" })
                      }
                    >
                      Approve
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-body text-fg-secondary">No approval is waiting for this run.</p>
              )}
              {decide.isError ? (
                <p role="alert" className="mt-2 text-caption text-danger">
                  Couldn't record the decision: {decide.error.message}
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
