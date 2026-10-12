import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { queries } from "@/api/queries";
import type { Knowledge } from "@/api/schemas";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { QueryView } from "@/components/ui/states";
import { ProductGraph } from "./product-graph";

export function KnowledgePage() {
  const { projectId } = useParams({ from: "/p/$projectId/knowledge" });
  const knowledge = useQuery(queries.knowledge(projectId));
  return (
    <QueryView query={knowledge}>
      {(data) => <KnowledgeView projectId={projectId} data={data} />}
    </QueryView>
  );
}

function KnowledgeView({ projectId, data }: { projectId: string; data: Knowledge }) {
  const withRules = data.adrs.filter((a) => a.rules !== "—").length;
  return (
    <>
      <PageHeader
        title={`${projectId} · Knowledge`}
        subtitle={data.summary}
        actions={
          <>
            <Button>Regenerate code graph</Button>
            <Button variant="primary">New ADR</Button>
          </>
        }
      />
      <Card>
        <CardHeader
          title="Product graph"
          meta={`goals → features → ADRs → tickets → modules · highlighted: ${data.highlight}`}
        />
        <ProductGraph nodes={data.graph.nodes} edges={data.graph.edges} />
      </Card>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_420px] gap-4">
        <Card>
          <CardHeader title="ADRs" meta={`${data.adrs.length} · ${withRules} with rules`} />
          <ul className="px-4 pb-2">
            {data.adrs.map((adr) => (
              <li
                key={adr.id}
                className="grid grid-cols-[minmax(0,1fr)_110px_100px_auto] items-center gap-3 border-border-subtle border-b py-3.5 last:border-0"
              >
                <span className="text-body text-fg">
                  {adr.id} {adr.title}
                </span>
                <span className="font-mono text-caption text-fg-secondary">{adr.area}</span>
                <span className="font-mono text-caption text-fg-secondary">{adr.rules}</span>
                <Pill tone={adr.status.tone} className="justify-self-end">
                  {adr.status.label}
                </Pill>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="self-start">
          <CardHeader title="Rule violations" meta={data.checkRef} />
          <ul className="space-y-2 px-4 pb-4">
            {data.violations.length === 0 ? (
              <li className="text-body text-fg-secondary">No violations on main.</li>
            ) : null}
            {data.violations.map((v) => (
              <li key={v.location} className="rounded-control bg-raised p-3">
                <div className="flex items-center gap-2">
                  <Pill tone={v.level === "error" ? "red" : "amber"}>{v.level}</Pill>
                  <span className="font-mono text-caption text-fg-secondary">{v.adr}</span>
                </div>
                <div className="mt-2 font-mono text-label text-fg">{v.location}</div>
                <div className="mt-1.5 text-body text-fg-secondary">{v.message}</div>
                <div className="mt-1.5 text-caption text-fg-muted">{v.note}</div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
