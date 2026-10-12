import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "@/api/client";
import { queries } from "@/api/queries";
import { autonomyValueSchema, type Settings } from "@/api/schemas";
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
      {(data) => <SettingsView key={projectId} projectId={projectId} settings={data} />}
    </QueryView>
  );
}

type Draft = Pick<Settings, "autonomy" | "runners">;

function SettingsView({ projectId, settings }: { projectId: string; settings: Settings }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft>({
    autonomy: settings.autonomy,
    runners: settings.runners,
  });
  const save = useMutation({
    mutationFn: (value: Draft) => api.saveSettings(projectId, value),
    onSuccess: (next) => {
      client.setQueryData(queries.settings(projectId).queryKey, next);
      setDraft({ autonomy: next.autonomy, runners: next.runners });
    },
  });
  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify({ autonomy: settings.autonomy, runners: settings.runners });

  return (
    <>
      <PageHeader
        title={`${projectId} · Settings`}
        subtitle="Autonomy, runners, API keys and integrations"
        actions={
          <>
            <Button>View audit log</Button>
            <Button
              variant="primary"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate(draft)}
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </>
        }
      />
      {save.isError ? (
        <p role="alert" className="-mt-3 mb-4 text-caption text-danger">
          Couldn't save settings. Try again.
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Autonomy per phase" meta={settings.autonomyNote} />
          <ul className="space-y-2.5 px-4 pb-4">
            {draft.autonomy.map((row, i) => (
              <li key={row.phase} className="flex items-center justify-between gap-4">
                <span className="text-body text-fg">{row.phase}</span>
                <Select
                  label={`Autonomy for ${row.phase}`}
                  value={row.value}
                  options={autonomyValueSchema.options}
                  highlight={row.value !== "auto"}
                  onValueChange={(value) =>
                    setDraft((d) => ({
                      ...d,
                      autonomy: d.autonomy.map((r, j) =>
                        j === i ? { ...r, value: autonomyValueSchema.parse(value) } : r,
                      ),
                    }))
                  }
                />
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Runners & models" meta="via CLIProxyAPI" />
          <ul className="space-y-2.5 px-4 pb-4">
            {draft.runners.map((row, i) => (
              <li key={row.phase} className="flex items-center justify-between gap-4">
                <span className="text-body text-fg">{row.phase}</span>
                <span className="flex gap-2">
                  <Select
                    label={`Runner for ${row.phase}`}
                    value={row.runner}
                    options={settings.runnerOptions}
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
                    options={settings.modelOptions}
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
        </Card>

        <ApiKeysCard projectId={projectId} keys={settings.apiKeys} />

        <Card>
          <CardHeader title="Integrations" />
          <ul className="px-4 pb-2">
            {settings.integrations.map((integration) => (
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
        </Card>
      </div>
    </>
  );
}
