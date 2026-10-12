import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { endpoints } from "@/api/endpoints";
import { queries } from "@/api/queries";
import { type ApiKey, KEY_ACTIONS, type KeyAction } from "@/api/view";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";

export const newKeySchema = z.object({
  name: z.string().trim().min(2, "Name needs at least 2 characters").max(48),
  actions: z.array(z.enum(KEY_ACTIONS)).min(1, "Pick at least one action"),
  runsPerDay: z.string().regex(/^\d{0,5}$/, "Runs per day is a whole number"),
});

function budgetLabel(key: ApiKey): string {
  const parts = [];
  if (key.budget.runsPerDay) parts.push(`${key.budget.runsPerDay} runs/day`);
  if (key.budget.mutationsPerDay) parts.push(`${key.budget.mutationsPerDay} writes/day`);
  return parts.length ? parts.join(" · ") : "no budget";
}

export function ApiKeysCard({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const keys = useQuery(queries.keys());
  const revoke = useMutation({
    mutationFn: (id: string) => endpoints.revokeKey(id),
    onSuccess: () => client.invalidateQueries({ queryKey: queries.keys().queryKey }),
  });

  return (
    <Card>
      <CardHeader title="API keys" meta={<NewKeyDialog projectId={projectId} />} />
      {keys.isError ? (
        <p role="alert" className="px-4 pb-4 text-caption text-danger">
          Couldn't load keys: {keys.error.message}
        </p>
      ) : null}
      <ul className="px-4 pb-2">
        {(keys.data ?? []).map((key) => {
          const active = !key.revokedAt;
          return (
            <li key={key.id} className="border-border-subtle border-b py-3 last:border-0">
              <div className="flex items-center justify-between gap-3">
                <span className="text-heading text-fg">{key.name}</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-caption text-fg-muted">{key.kind}</span>
                  <Pill tone={active ? "green" : "neutral"}>{active ? "active" : "revoked"}</Pill>
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-3">
                <span className="font-mono text-caption text-fg-secondary">
                  {key.scope.actions.join(" · ")} · {budgetLabel(key)}
                </span>
                {active ? (
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
          );
        })}
      </ul>
    </Card>
  );
}

function NewKeyDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: (input: { name: string; actions: KeyAction[]; runsPerDay: string }) =>
      endpoints.createKey({
        name: input.name.trim(),
        actions: input.actions,
        projectId,
        runsPerDay: input.runsPerDay ? Number(input.runsPerDay) : null,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queries.keys().queryKey }),
  });
  const form = useForm({
    defaultValues: { name: "", actions: ["read"] as KeyAction[], runsPerDay: "" },
    validators: { onSubmit: newKeySchema },
    onSubmit: async ({ value }) => {
      await create.mutateAsync(value);
    },
  });
  // The token lives only in the mutation result; closing the dialog resets it.
  const token = create.data?.token ?? null;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      create.reset();
      form.reset();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">New key</Button>
      </DialogTrigger>
      <DialogContent
        title={token ? "Copy your key now" : "New API key"}
        description={
          token
            ? "This is the only time the full key is shown. Store it in your agent's secret store."
            : "Keys work for both MCP and REST. Give each agent its own key with the smallest set of actions it needs."
        }
      >
        {token ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-control border border-border-strong bg-canvas p-3">
              <code className="flex-1 truncate font-mono text-caption text-accent">{token}</code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void navigator.clipboard?.writeText(token)}
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
            <form.Field name="actions">
              {(field) => (
                <fieldset>
                  <legend className="text-label text-fg-secondary">
                    Allowed actions on {projectId}
                  </legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {KEY_ACTIONS.map((action) => {
                      const checked = field.state.value.includes(action);
                      return (
                        <label
                          key={action}
                          className={cn(
                            "cursor-pointer rounded-control border px-2 py-1 font-mono text-caption has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-2",
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
                                  ? field.state.value.filter((a) => a !== action)
                                  : [...field.state.value, action],
                              )
                            }
                          />
                          {action}
                        </label>
                      );
                    })}
                  </div>
                  <FieldError errors={field.state.meta.errors} />
                </fieldset>
              )}
            </form.Field>
            <form.Field name="runsPerDay">
              {(field) => (
                <label className="block">
                  <span className="text-label text-fg-secondary">Runs per day (optional)</span>
                  <input
                    inputMode="numeric"
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
                Couldn't create the key: {create.error.message}
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
