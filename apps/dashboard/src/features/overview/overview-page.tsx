import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { queries } from "@/api/queries";
import type { OverviewView } from "@/api/view";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, StatTile } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { EmptyState, QueryView } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { usd } from "@/lib/format";

export function OverviewPage() {
  const query = useQuery(queries.overview());
  return <QueryView query={query}>{(data) => <Overview data={data} />}</QueryView>;
}

function Overview({ data }: { data: OverviewView }) {
  const { stats } = data;
  return (
    <>
      <PageHeader
        title="Factory overview"
        subtitle={`${data.projects.length} projects · ${stats.activeRuns} active runs`}
        actions={
          <Button asChild variant="primary">
            <Link to="/new">New project</Link>
          </Button>
        }
      />
      <div className="grid grid-cols-4 gap-4">
        <StatTile
          label="Active runs"
          value={String(stats.activeRuns)}
          note={`${stats.queuedRuns} queued`}
        />
        <StatTile
          label="Pending approvals"
          value={String(stats.pendingApprovals)}
          note="waiting for a human decision"
        />
        <StatTile label="Cost today" value={usd(stats.costTodayUsd)} note="across all projects" />
        <StatTile
          label="Open incidents"
          value={String(stats.openIncidents)}
          note="from prod signals"
        />
      </div>

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)_380px] gap-4">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Active runs" meta="live" />
            {data.activeRuns.length === 0 ? (
              <p className="px-4 pb-4 text-body text-fg-secondary">No run in progress.</p>
            ) : (
              <ul className="px-4 pb-2">
                {data.activeRuns.map((run) => (
                  <li key={run.id} className="border-border-subtle border-b last:border-0">
                    <Link
                      to="/p/$projectId/runs/$runId"
                      params={{ projectId: run.projectId, runId: run.id }}
                      className="grid grid-cols-[minmax(0,1fr)_200px_70px_auto] items-center gap-4 rounded px-2 py-3.5 hover:bg-hover"
                    >
                      <span className="truncate text-body text-fg">
                        {run.ticketId} <span className="text-fg-secondary">· {run.projectId}</span>
                      </span>
                      <span className="truncate font-mono text-caption text-fg-secondary">
                        {run.phase} · {run.model}
                      </span>
                      <span className="font-mono text-caption text-fg-secondary">
                        {usd(run.costUsd)}
                      </span>
                      <Pill tone={run.status.tone} className="justify-self-end">
                        {run.status.label}
                      </Pill>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Projects" meta={String(data.projects.length)} />
            {data.projects.length === 0 ? (
              <div className="px-4 pb-4">
                <EmptyState
                  title="No projects yet"
                  hint="Create one, or run the init interview on an existing repo."
                />
              </div>
            ) : (
              <ul className="px-4 pb-2">
                {data.projects.map((project) => (
                  <li key={project.id} className="border-border-subtle border-b last:border-0">
                    <Link
                      to="/p/$projectId/board"
                      params={{ projectId: project.id }}
                      className="grid grid-cols-[minmax(0,1fr)_120px_180px_auto] items-center gap-4 rounded px-2 py-3.5 hover:bg-hover"
                    >
                      <span className="text-body text-fg">{project.name}</span>
                      <span className="font-mono text-caption text-fg-secondary">
                        {project.workspace}
                      </span>
                      <span className="truncate font-mono text-caption text-fg-secondary">
                        {project.summary}
                      </span>
                      <Pill tone={project.status.tone} className="justify-self-end">
                        {project.status.label}
                      </Pill>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Models & rate limits" meta="gateway" />
            <ul className="space-y-4 px-4 pb-4">
              {data.models.map((model) => (
                <li key={model.id}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-label text-fg">{model.id}</span>
                    <Pill tone={model.status.tone}>{model.status.label}</Pill>
                  </div>
                  {model.usage !== null ? (
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-raised">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          model.status.tone === "green" && "bg-accent",
                          model.status.tone === "amber" && "bg-warn",
                          model.status.tone === "red" && "bg-danger",
                        )}
                        style={{ width: `${Math.round(model.usage * 100)}%` }}
                      />
                    </div>
                  ) : null}
                  {model.note ? (
                    <div className="mt-1.5 text-caption text-fg-muted">{model.note}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="Orca runtime"
              meta={<Pill tone={data.orca.status.tone}>{data.orca.status.label}</Pill>}
            />
            <dl className="space-y-3 px-4 pb-4">
              {(
                [
                  ["host", data.orca.host],
                  ["worktrees", data.orca.worktrees],
                  ["last seen", data.orca.lastSeen],
                ] as const
              ).map(([term, value]) => (
                <div key={term} className="flex items-center justify-between gap-4">
                  <dt className="text-body text-fg-secondary">{term}</dt>
                  <dd className="truncate font-mono text-caption text-fg">{value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card>
            <CardHeader title="Alerts" meta="now" />
            <ul className="space-y-4 px-4 pb-4">
              {data.alerts.length === 0 ? (
                <li className="text-body text-fg-secondary">Nothing needs you.</li>
              ) : null}
              {data.alerts.map((alert) => (
                <li key={`${alert.kind.label}:${alert.message}`}>
                  <Pill tone={alert.kind.tone}>{alert.kind.label}</Pill>
                  <p className="mt-1.5 text-body text-fg-secondary">{alert.message}</p>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
