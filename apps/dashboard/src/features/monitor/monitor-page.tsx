import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { Verification } from "@/api/contracts";
import { queries } from "@/api/queries";
import type { Incident, Tone } from "@/api/view";
import { PageHeader } from "@/components/page-header";
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

function VerificationChart({ verification }: { verification: Verification }) {
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

type MonitorData = { incidents: Incident[]; verification: Verification | null };

const STATUS_TONE: Record<Incident["status"], Tone> = {
  open: "red",
  fixing: "blue",
  resolved: "green",
};

function severity(i: Incident): { label: string; tone: Tone } {
  if (i.status === "resolved") return { label: "resolved", tone: "green" };
  if (i.count >= 100) return { label: "critical", tone: "red" };
  if (i.count >= 20) return { label: "major", tone: "amber" };
  return { label: "minor", tone: "neutral" };
}

function MonitorView({ projectId, data }: { projectId: string; data: MonitorData }) {
  const open = data.incidents.filter((i) => i.status === "open").length;
  const fixing = data.incidents.filter((i) => i.status === "fixing").length;
  const resolved = data.incidents.filter((i) => i.status === "resolved").length;
  const sources = [...new Set(data.incidents.map((i) => i.source))];
  return (
    <>
      <PageHeader
        title={`${projectId} · Prod monitor`}
        subtitle="Incidents grouped by root cause, fix tickets and post-deploy checks"
        actions={
          sources.length ? <Pill tone="green">{`${sources.join(" + ")} connected`}</Pill> : null
        }
      />
      <div className="grid grid-cols-4 gap-4">
        <StatTile label="Open incidents" value={String(open)} note="not picked up yet" />
        <StatTile label="Auto-fixing" value={String(fixing)} note="fix ticket in the loop" />
        <StatTile label="Resolved" value={String(resolved)} note="verified after deploy" />
        <StatTile
          label="Events"
          value={String(data.incidents.reduce((n, i) => n + i.count, 0))}
          note="across all incidents"
        />
      </div>
      <div className="mt-5 grid grid-cols-[minmax(0,1fr)_400px] gap-4">
        <Card className="self-start">
          <CardHeader title="Incidents by root cause" meta={`${data.incidents.length} groups`} />
          {data.incidents.length === 0 ? (
            <p className="px-4 pb-4 text-body text-fg-secondary">No incidents. Prod is quiet.</p>
          ) : (
            <ul className="space-y-3 px-4 pb-4">
              {data.incidents.map((incident) => {
                const sev = severity(incident);
                return (
                  <li
                    key={incident.id}
                    className="rounded-control border border-border-subtle bg-raised p-4"
                  >
                    <div className="flex items-center gap-3">
                      <Pill tone={sev.tone}>{sev.label}</Pill>
                      <span className="text-heading text-fg">{incident.title}</span>
                      <span className="ml-auto font-mono text-caption text-fg-muted">
                        {incident.count} events · {incident.source}
                      </span>
                    </div>
                    <p className="mt-2 font-mono text-caption text-fg-secondary">
                      {incident.fingerprint}
                    </p>
                    <div className="mt-2 flex items-center gap-3">
                      {typeof incident.fixability === "number" ? (
                        <span className="font-mono text-caption text-fg">
                          fixability {incident.fixability.toFixed(2)}
                        </span>
                      ) : null}
                      <Pill tone={STATUS_TONE[incident.status]}>
                        {incident.ticketId
                          ? `${incident.ticketId} · ${incident.status}`
                          : incident.status}
                      </Pill>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card className="self-start">
          <CardHeader
            title="Post-deploy verification"
            meta={
              data.verification
                ? `${data.verification.deploy} · ${data.verification.ago}`
                : "no deploy yet"
            }
          />
          <div className="px-4 pb-4">
            {data.verification ? (
              <>
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
              </>
            ) : (
              <p className="text-body text-fg-secondary">
                The next deploy will show its error-rate check here.
              </p>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
