import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import { endpoints } from "@/api/endpoints";
import { ApiError } from "@/api/http";
import { queries } from "@/api/queries";
import type { S } from "@/api/view";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import type { Contradiction } from "./engine";

export function ContradictionsCard({
  items,
  onReask,
}: {
  items: Contradiction[];
  onReask: (questionIds: string[]) => void;
}) {
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
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="truncate font-mono text-caption text-fg-muted">
                {c.questions.join(", ")}
              </span>
              <button
                type="button"
                onClick={() => onReask(c.questions)}
                className="shrink-0 rounded-control border border-border-strong px-2 py-1 text-caption text-fg hover:bg-hover"
              >
                Re-ask
              </button>
            </div>
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
  onReask,
  initialResult,
}: {
  projectId: string;
  sessionId: string;
  blocking: number;
  onReask: (ids: string[]) => void;
  initialResult?: S["InitSession"]["result"];
}) {
  const client = useQueryClient();
  const finalize = useMutation({
    mutationFn: () => endpoints.finalizeInit(sessionId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queries.init(sessionId).queryKey });
      void client.invalidateQueries({ queryKey: ["projects", projectId] });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: queries.init(sessionId).queryKey });
    },
  });
  const details =
    finalize.error instanceof ApiError
      ? z
          .array(
            z.object({
              id: z.string(),
              severity: z.enum(["error", "warning"]).default("error"),
              message: z.string(),
              questions: z.array(z.string()),
            }),
          )
          .safeParse(finalize.error.details)
      : null;
  const result = finalize.data?.result ?? initialResult;
  const missing =
    finalize.error instanceof ApiError &&
    (finalize.error.status === 404 || finalize.error.status === 405);
  // The server re-checks consistency on finalize and answers 409 when answers contradict.
  const inconsistent = finalize.error instanceof ApiError && finalize.error.status === 409;
  return (
    <Card>
      <CardHeader title="Generate the project" meta="step 3 of 3" />
      <div className="px-5 pb-5">
        {result?.status === "ok" ? (
          <div role="status">
            <p>Project generated. Artifacts:</p>
            <ul>
              {result.files.map((file) => (
                <li key={file} className="font-mono text-caption">
                  {file}
                </li>
              ))}
            </ul>
            <p>{result.tickets.length} backlog tickets created.</p>
            {result.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
            <Link to="/p/$projectId/board" params={{ projectId }}>
              Open project board
            </Link>
          </div>
        ) : null}
        {result && result.status !== "ok" ? (
          <p role="alert">
            Generation incomplete: {result.status}. Your project is not ready; review the interview.
          </p>
        ) : null}
        {finalize.isSuccess && !result ? (
          <p role="alert">
            The server returned no generation result. Project generation is not confirmed.
          </p>
        ) : null}
        {details?.success ? <ContradictionsCard items={details.data} onReask={onReask} /> : null}
        <p className="text-body text-fg-secondary">
          Writes matrix.config.ts, the ADRs and the scaffold, then seeds the backlog on the board.
        </p>
        {blocking > 0 ? (
          <p role="alert" className="mt-3 text-caption text-danger">
            Resolve {blocking} contradiction{blocking > 1 ? "s" : ""} first: use Re-ask in the
            Contradictions panel or Edit in Your answers.
          </p>
        ) : null}
        {finalize.isError ? (
          <p role="alert" className="mt-3 text-caption text-danger">
            {missing
              ? FINALIZE_MISSING
              : inconsistent
                ? `The server found contradictions: ${finalize.error.message}`
                : `Couldn't generate the project: ${finalize.error.message}`}
          </p>
        ) : null}
        <Button
          className="mt-4"
          variant="primary"
          disabled={finalize.isPending || blocking > 0 || result?.status === "ok"}
          onClick={() => finalize.mutate()}
        >
          {finalize.isPending ? "Generating…" : "Generate project"}
        </Button>
      </div>
    </Card>
  );
}
