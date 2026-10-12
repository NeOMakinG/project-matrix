import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { endpoints } from "@/api/endpoints";
import { ApiError } from "@/api/http";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import type { Contradiction } from "./engine";

export function ContradictionsCard({ items }: { items: Contradiction[] }) {
  return (
    <Card>
      <CardHeader title="Contradictions" meta={items.length ? `${items.length} found` : "none"} />
      <ul aria-live="polite" className="space-y-2 px-4 pb-4">
        {items.length === 0 ? (
          <li className="text-body text-fg-secondary">The answers are consistent.</li>
        ) : null}
        {items.map((c) => (
          <li key={c.id} role="alert" className="rounded-control bg-raised p-3">
            <Pill tone={c.severity === "error" ? "red" : "amber"}>{c.severity}</Pill>
            <p className="mt-1.5 text-body text-fg">{c.message}</p>
            <p className="mt-1 font-mono text-caption text-fg-muted">
              re-ask: {c.questions.join(", ")}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function PreviewCards({ config, adrs }: { config: string; adrs: string[] }) {
  return (
    <>
      <Card>
        <CardHeader title="matrix.config.ts" meta={<Pill tone="neutral">live preview</Pill>} />
        <pre
          aria-label="matrix.config.ts preview"
          className="mx-4 mb-4 max-h-80 overflow-auto rounded-control bg-canvas p-3 font-mono text-caption text-fg"
        >
          {config}
        </pre>
      </Card>
      <Card>
        <CardHeader title="Generated ADRs" meta={String(adrs.length)} />
        <ol className="space-y-2 px-4 pb-4">
          {adrs.length === 0 ? <li className="text-body text-fg-secondary">None yet.</li> : null}
          {adrs.map((title, i) => (
            <li key={title} className="grid grid-cols-[40px_minmax(0,1fr)] gap-2">
              <span className="font-mono text-caption text-fg-muted">
                {String(i + 1).padStart(4, "0")}
              </span>
              <span className="text-body text-fg">{title}</span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}

export const FINALIZE_MISSING =
  "The server can't finalize interviews yet (POST /v1/init/{id}/finalize is missing). Your answers and autonomy are saved.";

export function FinalizeStep({
  projectId,
  sessionId,
  blocking,
}: {
  projectId: string;
  sessionId: string;
  blocking: number;
}) {
  const navigate = useNavigate();
  const finalize = useMutation({
    mutationFn: () => endpoints.finalizeInit(sessionId),
    onSuccess: () => navigate({ to: "/p/$projectId/board", params: { projectId } }),
  });
  const missing =
    finalize.error instanceof ApiError &&
    (finalize.error.status === 404 || finalize.error.status === 405);
  return (
    <Card>
      <CardHeader title="Generate the project" meta="step 3 of 3" />
      <div className="px-5 pb-5">
        <p className="text-body text-fg-secondary">
          Writes matrix.config.ts, the ADRs and the scaffold, then seeds the backlog on the board.
        </p>
        {blocking > 0 ? (
          <p role="alert" className="mt-3 text-caption text-danger">
            Resolve {blocking} contradiction{blocking > 1 ? "s" : ""} first.
          </p>
        ) : null}
        {finalize.isError ? (
          <p role="alert" className="mt-3 text-caption text-danger">
            {missing
              ? FINALIZE_MISSING
              : `Couldn't generate the project: ${finalize.error.message}`}
          </p>
        ) : null}
        <Button
          className="mt-4"
          variant="primary"
          disabled={finalize.isPending || blocking > 0}
          onClick={() => finalize.mutate()}
        >
          {finalize.isPending ? "Generating…" : "Generate project"}
        </Button>
      </div>
    </Card>
  );
}
