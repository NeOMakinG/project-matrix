import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { endpoints } from "@/api/endpoints";
import { ApiError } from "@/api/http";
import { queries } from "@/api/queries";
import { AUTONOMY_LABEL, AUTONOMY_MODES, type AutonomyMode, type SettingsView } from "@/api/view";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { Select } from "@/components/ui/select";
import { QueryView } from "@/components/ui/states";
import { ApiKeysCard } from "./api-keys";

export function SettingsPage() {
  const { projectId } = useParams({ from: "/p/$projectId/settings" });
  const settings = useQuery(queries.settings(projectId));
  return (
    <QueryView query={settings}>
      {(data) => (
        <SettingsForm
          key={`${projectId}:${data.etag ?? ""}`}
          projectId={projectId}
          settings={data}
        />
      )}
    </QueryView>
  );
}

const LABEL_TO_MODE = Object.fromEntries(
  AUTONOMY_MODES.map((m) => [AUTONOMY_LABEL[m], m]),
) as Record<string, AutonomyMode>;

type Draft = Pick<SettingsView, "autonomy" | "runners">;

/** Conditional settings write first (If-Match), so a conflict aborts before any autonomy change. */
export async function saveSettings(
  projectId: string,
  before: SettingsView,
  draft: Draft,
): Promise<void> {
  if (JSON.stringify(draft.runners) !== JSON.stringify(before.runners)) {
    await endpoints.saveRunners(draft.runners, before.etag);
  }
  const changedAutonomy = draft.autonomy.filter((row, i) => row.mode !== before.autonomy[i]?.mode);
  for (const row of changedAutonomy) await endpoints.setAutonomy(projectId, row.phase, row.mode);
}

function SettingsForm({ projectId, settings }: { projectId: string; settings: SettingsView }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft>({
    autonomy: settings.autonomy,
    runners: settings.runners,
  });
  const reload = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queries.settings(projectId).queryKey }),
      client.invalidateQueries({ queryKey: queries.project(projectId).queryKey }),
    ]);
  const save = useMutation({
    mutationFn: () => saveSettings(projectId, settings, draft),
    onSuccess: reload,
  });
  const conflict = save.error instanceof ApiError && save.error.status === 412;
  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify({ autonomy: settings.autonomy, runners: settings.runners });

  return (
    <>
      <PageHeader
        title={`${projectId} · Settings`}
        subtitle="Autonomy, runners, API keys and integrations"
        actions={
          <Button
            variant="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        }
      />
      {conflict ? (
        <div role="alert" className="-mt-3 mb-4 flex items-center gap-3 text-caption text-warn">
          Settings changed somewhere else since you opened this page. Reload to see them, then
          reapply your edits.
          <Button size="sm" onClick={() => void reload()}>
            Reload
          </Button>
        </div>
      ) : save.isError ? (
        <p role="alert" className="-mt-3 mb-4 text-caption text-danger">
          Couldn't save settings: {save.error.message}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Autonomy per phase" meta="who merges and deploys" />
          <ul className="space-y-2.5 px-4 pb-4">
            {draft.autonomy.map((row, i) => (
              <li key={row.phase} className="flex items-center justify-between gap-4">
                <span className="text-body text-fg">{row.phase}</span>
                <Select
                  label={`Autonomy for ${row.phase}`}
                  value={AUTONOMY_LABEL[row.mode]}
                  options={AUTONOMY_MODES.map((m) => AUTONOMY_LABEL[m])}
                  highlight={row.mode !== "autonomous"}
                  onValueChange={(label) => {
                    const mode = LABEL_TO_MODE[label];
                    if (!mode) return;
                    setDraft((d) => ({
                      ...d,
                      autonomy: d.autonomy.map((r, j) => (j === i ? { ...r, mode } : r)),
                    }));
                  }}
                />
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Runners & models" meta="via CLIProxyAPI" />
          {draft.runners.length === 0 ? (
            <p className="px-4 pb-4 text-body text-fg-secondary">
              No runner overrides: the factory defaults apply.
            </p>
          ) : (
            <ul className="space-y-2.5 px-4 pb-4">
              {draft.runners.map((row, i) => (
                <li key={row.phase} className="flex items-center justify-between gap-4">
                  <span className="text-body text-fg">{row.phase}</span>
                  <span className="flex gap-2">
                    <Select
                      label={`Runner for ${row.phase}`}
                      value={row.runner}
                      options={withValue(settings.runnerOptions, row.runner)}
                      onValueChange={(runner) =>
                        setDraft((d) => ({
                          ...d,
                          runners: d.runners.map((r, j) => (j === i ? { ...r, runner } : r)),
                        }))
                      }
                    />
                    <Select
                      label={`Model for ${row.phase}`}
                      value={row.model}
                      options={withValue(settings.modelOptions, row.model)}
                      onValueChange={(model) =>
                        setDraft((d) => ({
                          ...d,
                          runners: d.runners.map((r, j) => (j === i ? { ...r, model } : r)),
                        }))
                      }
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <ApiKeysCard projectId={projectId} />
        <IntegrationsCard />
      </div>
    </>
  );
}

function withValue(options: string[], value: string): string[] {
  return options.includes(value) ? options : [value, ...options];
}

function IntegrationsCard() {
  const integrations = useQuery(queries.integrations());
  return (
    <Card>
      <CardHeader title="Integrations" />
      {integrations.isError ? (
        <p className="px-4 pb-4 text-body text-fg-secondary">
          Integrations aren't available from the server yet.
        </p>
      ) : (
        <ul className="px-4 pb-2">
          {(integrations.data ?? []).map((integration) => (
            <li
              key={integration.name}
              className="flex items-center gap-3 border-border-subtle border-b py-3 last:border-0"
            >
              <span
                aria-hidden
                className="size-7 shrink-0 rounded-control border border-border-subtle bg-raised"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-heading text-fg">{integration.name}</span>
                <span className="block truncate font-mono text-caption text-fg-secondary">
                  {integration.detail}
                </span>
              </span>
              <Pill tone={integration.status.tone}>{integration.status.label}</Pill>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
