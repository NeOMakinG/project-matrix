import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp } from "lucide-react";
import { queries } from "@/api/queries";
import type { RunSummaryView as RunSummary } from "@/api/view";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { EmptyState, QueryView } from "@/components/ui/states";
import { clock, usd } from "@/lib/format";

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
});
const helper = createColumnHelper<typeof features, RunSummary>();

const STATUS_TONE = { running: "blue", paused: "amber", done: "green", failed: "red" } as const;

function makeColumns(projectId: string) {
  return helper.columns([
    helper.accessor("ticketId", { header: "Ticket", sortFn: "alphanumeric" }),
    helper.accessor("title", {
      header: "Title",
      sortFn: "text",
      cell: (info) => (
        <Link
          to="/p/$projectId/runs/$runId"
          params={{ projectId, runId: info.row.original.id }}
          className="text-fg hover:text-accent"
        >
          {info.getValue()}
        </Link>
      ),
    }),
    helper.accessor("phase", { header: "Phase", sortFn: "text" }),
    helper.accessor("model", { header: "Model", sortFn: "text" }),
    helper.accessor("costUsd", { header: "Cost", cell: (info) => usd(info.getValue()) }),
    helper.accessor("startedAt", {
      header: "Started (UTC)",
      sortFn: "text",
      cell: (info) => clock(info.getValue()),
    }),
    helper.accessor("status", {
      header: "Status",
      sortFn: "text",
      cell: (info) => <Pill tone={STATUS_TONE[info.getValue()]}>{info.getValue()}</Pill>,
    }),
  ]);
}

export function RunsPage() {
  const { projectId } = useParams({ from: "/p/$projectId/runs" });
  const runs = useQuery(queries.runs(projectId));
  return (
    <>
      <PageHeader
        title={`${projectId} · Runs`}
        subtitle="Every agent run, newest first. Click a run for its live log and receipts."
      />
      <QueryView query={runs}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              title="No runs yet"
              hint="Runs appear here once a ticket is ready and the factory picks it up."
            />
          ) : (
            <RunsTable projectId={projectId} runs={list} />
          )
        }
      </QueryView>
    </>
  );
}

function RunsTable({ projectId, runs }: { projectId: string; runs: RunSummary[] }) {
  const table = useTable({
    features,
    columns: makeColumns(projectId),
    data: runs,
    initialState: { sorting: [{ id: "startedAt", desc: true }] },
  });

  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left">
        <thead className="border-border-subtle border-b">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <th key={header.id} className="px-4 py-3 text-caption font-medium text-fg-muted">
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className="inline-flex items-center gap-1 hover:text-fg"
                    >
                      <table.FlexRender header={header} />
                      {sorted === "asc" ? <ArrowUp className="size-3" /> : null}
                      {sorted === "desc" ? <ArrowDown className="size-3" /> : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-border-subtle border-b last:border-0 hover:bg-hover">
              {row.getAllCells().map((cell) => (
                <td key={cell.id} className="px-4 py-3 font-mono text-caption text-fg-secondary">
                  <table.FlexRender cell={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
