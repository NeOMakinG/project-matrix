import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { queries } from "@/api/queries";
import { API_SCOPES, type ApiKey, newApiKeySchema, type Settings } from "@/api/schemas";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";

export function ApiKeysCard({ projectId, keys }: { projectId: string; keys: ApiKey[] }) {
  const client = useQueryClient();
  const settingsKey = queries.settings(projectId).queryKey;
  const revoke = useMutation({
    mutationFn: (keyId: string) => api.revokeApiKey(projectId, keyId),
    onSuccess: (settings) => client.setQueryData(settingsKey, settings),
  });

  return (
    <Card>
      <CardHeader title="API keys" meta={<NewKeyDialog projectId={projectId} />} />
      <ul className="px-4 pb-2">
        {keys.map((key) => (
          <li key={key.id} className="border-border-subtle border-b py-3 last:border-0">
            <div className="flex items-center justify-between gap-3">
              <span className="text-heading text-fg">{key.name}</span>
              <span className="flex items-center gap-2">
                <span className="font-mono text-caption text-fg-muted">{key.prefix}</span>
                <Pill tone={key.status === "active" ? "green" : "neutral"}>{key.status}</Pill>
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <span className="font-mono text-caption text-fg-secondary">
                {key.scopes.join(" · ")} · budget {key.budget}
              </span>
              {key.status === "active" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => revoke.mutate(key.id)}
                  disabled={revoke.isPending}
                  aria-label={`Revoke ${key.name}`}
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function NewKeyDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: (input: { name: string; scopes: string[]; budget: string }) =>
      api.createApiKey(projectId, input),
    onSuccess: ({ key, secret: value }) => {
      client.setQueryData<Settings>(queries.settings(projectId).queryKey, (prev) =>
        prev ? { ...prev, apiKeys: [key, ...prev.apiKeys] } : prev,
      );
      setSecret(value);
    },
  });
  const form = useForm({
    defaultValues: { name: "", scopes: ["read"] as string[], budget: "" },
    validators: { onSubmit: newApiKeySchema },
    onSubmit: async ({ value }) => {
      await create.mutateAsync(value);
    },
  });

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setSecret(null);
      form.reset();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">New key</Button>
      </DialogTrigger>
      <DialogContent
        title={secret ? "Copy your key now" : "New API key"}
        description={
          secret
            ? "This is the only time the full key is shown. Store it in your agent's secret store."
            : "Keys work for both MCP and REST. Give each agent its own key with the smallest scopes it needs."
        }
      >
        {secret ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-control border border-border-strong bg-canvas p-3">
              <code className="flex-1 truncate font-mono text-caption text-accent">{secret}</code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void navigator.clipboard?.writeText(secret)}
              >
                <Copy className="size-3.5" />
                Copy
              </Button>
            </div>
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <form.Field name="name">
              {(field) => (
                <label className="block">
                  <span className="text-label text-fg-secondary">Name</span>
                  <input
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    placeholder="e.g. laptop claude-code"
                    className="mt-1 h-9 w-full rounded-control border border-border-strong bg-canvas px-3 text-body outline-none focus:border-accent"
                  />
                  <FieldError errors={field.state.meta.errors} />
                </label>
              )}
            </form.Field>
            <form.Field name="scopes">
              {(field) => (
                <fieldset>
                  <legend className="text-label text-fg-secondary">Scopes</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {API_SCOPES.map((scope) => {
                      const checked = field.state.value.includes(scope);
                      return (
                        <label
                          key={scope}
                          className={cn(
                            "cursor-pointer rounded-control border px-2 py-1 font-mono text-caption",
                            checked
                              ? "border-accent bg-accent-dim text-accent"
                              : "border-border-strong text-fg-secondary",
                          )}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={checked}
                            onChange={() =>
                              field.handleChange(
                                checked
                                  ? field.state.value.filter((s) => s !== scope)
                                  : [...field.state.value, scope],
                              )
                            }
                          />
                          {scope}
                        </label>
                      );
                    })}
                  </div>
                  <FieldError errors={field.state.meta.errors} />
                </fieldset>
              )}
            </form.Field>
            <form.Field name="budget">
              {(field) => (
                <label className="block">
                  <span className="text-label text-fg-secondary">Daily budget (USD, optional)</span>
                  <input
                    inputMode="decimal"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="20"
                    className="mt-1 h-9 w-full rounded-control border border-border-strong bg-canvas px-3 font-mono text-body outline-none focus:border-accent"
                  />
                  <FieldError errors={field.state.meta.errors} />
                </label>
              )}
            </form.Field>
            {create.isError ? (
              <p role="alert" className="text-caption text-danger">
                Couldn't create the key. Try again.
              </p>
            ) : null}
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(submitting) => (
                <Button type="submit" variant="primary" disabled={submitting}>
                  Create key
                </Button>
              )}
            </form.Subscribe>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FieldError({ errors }: { errors: unknown[] }) {
  const first = errors[0];
  if (!first) return null;
  const message = typeof first === "string" ? first : (first as { message?: string }).message;
  return (
    <span role="alert" className="mt-1 block text-caption text-danger">
      {message ?? "Invalid value"}
    </span>
  );
}
