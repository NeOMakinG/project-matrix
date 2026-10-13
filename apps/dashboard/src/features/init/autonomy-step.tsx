import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { endpoints } from "@/api/endpoints";
import { ApiError } from "@/api/http";
import {
  ALL_PHASES,
  AUTONOMY_LABEL,
  AUTONOMY_MODES,
  type AutonomyMode,
  type ServerPhase,
} from "@/api/view";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import type { Answers } from "./engine";

/** The interview stores "gated-auto"; the server's autonomy modes call it "gated". */
export function mergeModeFromAnswers(answers: Answers): AutonomyMode {
  const value = answers["process.autonomy.merge"];
  if (value === "autonomous") return "autonomous";
  if (value === "gated-auto") return "gated";
  return "human";
}

export function initialAutonomy(answers: Answers): Record<ServerPhase, AutonomyMode> {
  const merge = mergeModeFromAnswers(answers);
  return Object.fromEntries(
    ALL_PHASES.map((phase) => [
      phase,
      phase === "merge" || phase === "deploy" ? merge : merge === "human" ? "autonomous" : merge,
    ]),
  ) as Record<ServerPhase, AutonomyMode>;
}

export async function saveAutonomy(
  projectId: string,
  next: Record<ServerPhase, AutonomyMode>,
  etag: string | null,
) {
  if (!etag)
    throw new ApiError(
      428,
      "etag_missing",
      "The project response has no ETag; autonomy was not submitted.",
    );
  return endpoints.setAutonomyPolicy(projectId, next, etag);
}

const LABEL_TO_MODE = Object.fromEntries(
  AUTONOMY_MODES.map((m) => [AUTONOMY_LABEL[m], m]),
) as Record<string, AutonomyMode>;

export function AutonomyStep({
  projectId,
  answers,
  onSaved,
}: {
  projectId: string;
  answers: Answers;
  onSaved: () => void;
}) {
  const client = useQueryClient();
  const [modes, setModes] = useState(() => initialAutonomy(answers));
  const [etag, setEtag] = useState<string | null | undefined>(undefined);
  const version = useQuery({
    queryKey: ["projects", projectId, "init-policy-version"],
    queryFn: () => endpoints.projectWithEtag(projectId),
    staleTime: Infinity,
  });
  const load = useMutation({
    mutationFn: () => endpoints.projectWithEtag(projectId),
    onSuccess: (response) => {
      setEtag(response.etag);
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      return saveAutonomy(
        projectId,
        modes,
        etag === undefined ? (version.data?.etag ?? null) : etag,
      );
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects", projectId] });
      onSaved();
    },
  });

  return (
    <Card>
      <CardHeader title="Autonomy per phase" meta="step 2 of 3 · changeable later in Settings" />
      <div className="px-5 pb-5">
        <p className="text-body text-fg-secondary">
          Prefilled from your merge answer. Agents always work in draft branches; this decides who
          moves work forward at each phase.
        </p>
        <ul className="mt-4 space-y-2.5">
          {ALL_PHASES.map((phase) => (
            <li key={phase} className="flex items-center justify-between gap-4">
              <span className="text-body text-fg">{phase}</span>
              <Select
                label={`Autonomy for ${phase}`}
                value={AUTONOMY_LABEL[modes[phase]]}
                options={AUTONOMY_MODES.map((m) => AUTONOMY_LABEL[m])}
                highlight={modes[phase] !== "autonomous"}
                onValueChange={(label) => {
                  const mode = LABEL_TO_MODE[label];
                  if (mode) setModes((m) => ({ ...m, [phase]: mode }));
                }}
              />
            </li>
          ))}
        </ul>
        {save.isError ? (
          <p role="alert" className="mt-3 text-caption text-danger">
            {save.error instanceof ApiError && save.error.status === 412
              ? "Autonomy changed on the server. Reload its version, review your choices, then explicitly retry."
              : `Couldn't confirm autonomy was saved: ${save.error.message}`}
          </p>
        ) : null}
        {save.error instanceof ApiError && save.error.status === 412 ? (
          <Button disabled={load.isPending} onClick={() => load.mutate()}>
            Reload project version
          </Button>
        ) : null}
        {load.isError ? <p role="alert">Couldn't reload project: {load.error.message}</p> : null}
        {version.isError ? (
          <p role="alert">Couldn't load project version: {version.error.message}</p>
        ) : null}
        <Button
          className="mt-4"
          variant="primary"
          disabled={save.isPending || version.isPending || version.isError || load.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save autonomy and continue"}
        </Button>
      </div>
    </Card>
  );
}
