import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { Monitor } from "@/api/contracts";
import { queries } from "@/api/queries";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, StatTile } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { QueryView } from "@/components/ui/states";

export function MonitorPage() {
  const { projectId } = useParams({ from: "/p/$projectId/monitor" });
  const monitor = useQuery(queries.monitor(projectId));
  return (
    <QueryView query={monitor}>
      {(data) => <MonitorView projectId={projectId} data={data} />}
    </QueryView>
  );
}

export function sparklinePath(series: number[], width: number, height: number, pad = 8): string {
  if (series.length === 0) return "";
  const max = Math.max(...series);
  const min = Math.min(...series);
  const span = max - min || 1;
  const step = series.length > 1 ? (width - pad * 2) / (series.length - 1) : 0;
  return series
    .map((v, i) => {
      const x = pad + i * step;
      const y = pad + (1 - (v - min) / span) * (height - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function VerificationChart({ verification }: { verification: Monitor["verification"] }) {
  const width = 364;
  const height = 138;
  const pad = 8;
  const step = (width - pad * 2) / Math.max(verification.series.length - 1, 1);
  const deployX = pad + verification.deployIndex * step;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Error rate before and after deploy ${verification.deploy}`}
      className="w-full rounded-control bg-raised"
    >
      <line
        x1={deployX}
        x2={deployX}
        y1={8}
        y2={height - 8}
        stroke="var(--color-info)"
        strokeDasharray="3 3"
      />
      <text x={deployX + 6} y={20} className="fill-info font-mono" fontSize="11">
        deploy {verification.deploy}
      </text>
      <path
        d={sparklinePath(verification.series, width, height, pad)}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MonitorView({ projectId, data }: { projectId: string; data: Monitor }) {
  return (
    <>
      <PageHeader
        title={`${projectId} · Prod monitor`}
        subtitle={data.environment}
        actions={
          <>
            <Pill tone={data.connected.tone}>{data.connected.label}</Pill>
            <Button>Mute 1h</Button>
          </>
        }
      />
      <div className="grid grid-cols-4 gap-4">
        {data.stats.map((s) => (
          <StatTile key={s.label} label={s.label} value={s.value} note={s.note} />
        ))}
      </div>
      <div className="mt-5 grid grid-cols-[minmax(0,1fr)_400px] gap-4">
        <Card className="self-start">
          <CardHeader title="Incidents by root cause" meta="last 24h" />
          <ul className="space-y-3 px-4 pb-4">
            {data.incidents.map((incident) => (
              <li
                key={incident.id}
                className="rounded-control border border-border-subtle bg-raised p-4"
              >
                <div className="flex items-center gap-3">
                  <Pill tone={incident.severity.tone}>{incident.severity.label}</Pill>
                  <span className="text-heading text-fg">
                    {incident.id} {incident.title}
                  </span>
                  <span className="ml-auto font-mono text-caption text-fg-muted">
                    {incident.events} events · {incident.users} users
                  </span>
                </div>
                <p className="mt-2 text-body text-fg-secondary">{incident.cause}</p>
                <div className="mt-2 flex items-center gap-3">
                  <span className="font-mono text-caption text-fg">
                    fixability {incident.fixability.toFixed(2)}
                  </span>
                  <Pill tone={incident.ticket.tone}>{incident.ticket.label}</Pill>
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="self-start">
          <CardHeader
            title="Post-deploy verification"
            meta={`${data.verification.deploy} · ${data.verification.ago}`}
          />
          <div className="px-4 pb-4">
            <VerificationChart verification={data.verification} />
            <dl className="mt-4 space-y-3">
              {data.verification.rows.map((row) => (
                <div key={row.label} className="flex items-center justify-between">
                  <dt className="text-body text-fg-secondary">{row.label}</dt>
                  <dd>
                    <Pill tone={row.value.tone}>{row.value.label}</Pill>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Card>
      </div>
    </>
  );
}
