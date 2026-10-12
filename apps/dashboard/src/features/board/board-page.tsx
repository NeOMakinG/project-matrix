import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { queries } from "@/api/queries";
import type { Project, Ticket } from "@/api/schemas";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { EmptyState, QueryView } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import {
  buildColumns,
  countByKind,
  filterTickets,
  KIND_FILTERS,
  type KindFilter,
} from "./board-logic";

export function BoardPage() {
  const { projectId } = useParams({ from: "/p/$projectId/board" });
  const project = useQuery(queries.project(projectId));
  const tickets = useQuery(queries.tickets(projectId));
  return (
    <QueryView query={project}>
      {(p) => (
        <>
          <BoardHeader project={p} />
          <QueryView query={tickets}>
            {(list) =>
              list.length === 0 ? (
                <EmptyState
                  title="No tickets yet"
                  hint="Run the init interview to generate the first backlog, or create a ticket."
                />
              ) : (
                <Board projectId={projectId} tickets={list} tracker={p.tracker} />
              )
            }
          </QueryView>
        </>
      )}
    </QueryView>
  );
}

function BoardHeader({ project }: { project: Project }) {
  return (
    <PageHeader
      title={`${project.name} · Board`}
      subtitle={`${project.description} · ${project.kind.split(" · ")[0]} · autonomy: ${project.autonomy}`}
      actions={
        <>
          <Pill tone="amber">autonomy: {project.autonomy}</Pill>
          <Button asChild>
            <Link to="/p/$projectId/init" params={{ projectId: project.id }}>
              Run interview again
            </Link>
          </Button>
          <Button variant="primary">New ticket</Button>
        </>
      }
    />
  );
}

function Board({
  projectId,
  tickets,
  tracker,
}: {
  projectId: string;
  tickets: Ticket[];
  tracker: string;
}) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [search, setSearch] = useState("");
  const [groupShip, setGroupShip] = useState(true);
  const counts = useMemo(() => countByKind(tickets), [tickets]);
  const columns = useMemo(
    () => buildColumns(filterTickets(tickets, kind, search), groupShip),
    [tickets, kind, search, groupShip],
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Ticket type" className="flex gap-2">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={kind === f.id}
              onClick={() => setKind(f.id)}
              className={cn(
                "h-7 rounded-control border px-2.5 text-label",
                kind === f.id
                  ? "border-border-strong bg-hover text-fg"
                  : "border-border-subtle text-fg-secondary hover:bg-hover",
              )}
            >
              {f.label} {counts[f.id]}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="relative">
            <span className="sr-only">Search tickets</span>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tickets, ADRs, files…"
              className="h-8 w-60 rounded-control border border-border-subtle bg-surface pr-3 pl-8 text-body text-fg outline-none placeholder:text-fg-muted focus:border-border-strong"
            />
          </label>
          <Button size="md" aria-pressed={groupShip} onClick={() => setGroupShip((v) => !v)}>
            {groupShip ? "Show all 8 phases" : "Group ship phases"}
          </Button>
          <span className="rounded-control border border-border-subtle px-2.5 py-1.5 text-label text-fg-secondary">
            Tracker: {tracker}
          </span>
        </div>
      </div>

      <div className="-mx-1 overflow-x-auto pb-3">
        <div className="flex gap-3 px-1">
          {columns.map((column) => (
            <section
              key={column.id}
              aria-label={`${column.label} column`}
              className="min-w-[176px] flex-1 basis-0 self-start rounded-card border border-border-subtle bg-surface p-2.5"
            >
              <h2 className="flex items-center gap-1.5 px-1 pt-1 pb-2.5 text-heading font-medium text-fg">
                {column.label}
                <span className="font-mono text-caption text-fg-muted">
                  {column.tickets.length}
                </span>
              </h2>
              <div className="flex flex-col gap-2">
                {column.tickets.map((ticket) => (
                  <TicketCard key={ticket.id} projectId={projectId} ticket={ticket} />
                ))}
                {column.tickets.length === 0 ? (
                  <p className="px-1 pb-1 text-caption text-fg-muted">Empty</p>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

function TicketCard({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="shrink-0 whitespace-nowrap font-mono text-caption text-fg-muted">
          {ticket.id}
        </span>
        <Pill tone={ticket.badge.tone}>{ticket.badge.label}</Pill>
      </div>
      <div className="mt-2 text-heading text-fg">{ticket.title}</div>
      <div className="mt-2 text-caption text-fg-secondary">{ticket.meta}</div>
    </>
  );
  const className =
    "block rounded-control border border-border-subtle bg-raised p-3 text-left hover:border-border-strong";
  return ticket.runId ? (
    <Link
      to="/p/$projectId/runs/$runId"
      params={{ projectId, runId: ticket.runId }}
      className={className}
    >
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
